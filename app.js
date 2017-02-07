/*
 *  _____                    _                    _
 * |  __ \                  | |                  | |
 * | |  | |  ___   ___  ____| |  ___    __ _   __| |  ___  _ __
 * | |  | | / _ \ / _ \|_  /| | / _ \  / _` | / _` | / _ \| '__|
 * | |__| ||  __/|  __/ / / | || (_) || (_| || (_| ||  __/| |
 * |_____/  \___| \___|/___||_| \___/  \__,_| \__,_| \___||_|
 *
 *
 *
 *  Maintained by ParadoxalManiak <https://www.reddit.com/user/ParadoxalManiak/>
 *  Original work by ZzMTV <https://boerse.to/members/zzmtv.3378614/>
 * */

// Setup error logging
var winston = require('winston');
winston.add(winston.transports.File, {
  filename: __dirname + '/deezloader.log',
  handleExceptions: true,
  humanReadableUnhandledException: true
});

var electron = require('electron');
var electronApp = electron.app;
var express = require('express');
var app = express();
var server = require('http').createServer(app);
var http = require('http');
var io = require('socket.io').listen(server, {log: false});
var fs = require('fs');
var async = require('async');
var request = require('request');
var nodeID3 = require('node-id3');
var Deezer = require('./deezer-api');
var mkdirp = require('mkdirp');
var configFile = require('./config.json');

// Setup the folders
var mainFolder = electronApp.getPath('music') + '\\Deezloader';

if (configFile.downloadLocation != null){
  mainFolder = configFile.downloadLocation;
}

initFolders();
module.exports.mainFolder = mainFolder;

// Route and Create server
app.use('/', express.static(__dirname + '/public/'));
server.listen(configFile.serverPort);
console.log('Server is running @ localhost:' + configFile.serverPort);

// Deezer API init START
// Initiate the Deezer API, or try to until the fucking server dies
var initialized = false; // The magic var

var tryInit = setInterval(function () {
  Deezer.init(function (err) {
    if (err) {
      console.log(err);
      return;
    }
    clearInterval(tryInit);
    initialized = true;
  });
}, 1000);
// END

// START sockets clusterfuck
io.sockets.on('connection', function (socket) {
  socket.downloadQueue = [];
  socket.downloadWorker = null;
  socket.lastQueueId = null;

  socket.on("checkInit", function (data) {
    socket.emit("checkInit", {status: initialized});
  });

  Deezer.onDownloadProgress = function (track, progress) {
    if (!track.trackSocket) {
      return;
    }
    var complete = 0;
    if (track.trackSocket.downloadWorker.type != "track") {
      return;
    }
    if (!track.trackSocket.downloadWorker.percentage) {
      track.trackSocket.downloadWorker.percentage = 0;
    }
    if (track["FILESIZE_MP3_320"] >= 0) {
      complete = track["FILESIZE_MP3_320"];
    } else if (track["FILESIZE_MP3_256"]) {
      complete = track["FILESIZE_MP3_256"];
    } else {
      complete = track["FILESIZE_MP3_128"] || 0;
    }

    var percentage = (progress / complete) * 100;

    if ((percentage - track.trackSocket.downloadWorker.percentage > 1) || (progress == complete)) {
      track.trackSocket.downloadWorker.percentage = percentage;
      track.trackSocket.emit("downloadProgress", {
        queueId: track.trackSocket.downloadWorker.queueId,
        percentage: track.trackSocket.downloadWorker.percentage
      });
    }
  };

  function queueWorker() {
    if (socket.downloadWorker != null || socket.downloadQueue.length == 0) {
      if (socket.downloadQueue.length == 0 && socket.downloadWorker == null) {
        socket.emit("emptyDownloadQueue", {});
      }
      return;
    }
    socket.downloadWorker = socket.downloadQueue[0];
    if (socket.lastQueueId != socket.downloadWorker.queueId) {
      socket.emit("downloadStarted", {queueId: socket.downloadWorker.queueId});
      socket.lastQueueId = socket.downloadWorker.queueId;
    }

    if (socket.downloadWorker.type == "track") {
      downloadTrack(socket.downloadWorker.id, socket.downloadWorker.settings, function (err) {
        if (err) {
          socket.downloadWorker.failed++;
        } else {
          socket.downloadWorker.downloaded++;
        }
        socket.emit("updateQueue", socket.downloadWorker);
        if (socket.downloadWorker && socket.downloadQueue[0] && (socket.downloadQueue[0].queueId == socket.downloadWorker.queueId)) socket.downloadQueue.shift();
        socket.downloadWorker = null;
        queueWorker();
      });
    } else if (socket.downloadWorker.type == "playlist") {
      Deezer.getPlaylistTracks(socket.downloadWorker.id, function (err, tracks) {
        for (var i = 0; i < tracks.data.length; i++) {
          tracks.data[i] = tracks.data[i].id;
        }
        socket.downloadWorker.playlistContent = tracks.data;
        socket.downloadWorker.settings.addToPath = socket.downloadWorker.name;
        async.eachSeries(socket.downloadWorker.playlistContent, function (id, callback) {
          if (socket.downloadWorker.cancelFlag) {
            callback("stop");
            return;
          }
          socket.downloadWorker.settings.playlist = {
            position: socket.downloadWorker.playlistContent.indexOf(id),
            fullSize: socket.downloadWorker.playlistContent.length
          };
          downloadTrack(id, socket.downloadWorker.settings, function (err) {
            if (!err) {
              socket.downloadWorker.downloaded++;
            } else {
              console.log(err);
              socket.downloadWorker.failed++;
            }
            socket.emit("updateQueue", socket.downloadWorker);
            callback();
          });
        }, function (err) {
          console.log("Playlist finished: " + socket.downloadWorker.name);
          if (socket.downloadWorker && socket.downloadQueue[0] && socket.downloadQueue[0].queueId == socket.downloadWorker.queueId) socket.downloadQueue.shift();
          socket.downloadWorker = null;
          queueWorker();
        });
      });
    } else if (socket.downloadWorker.type == "album") {
      Deezer.getAlbumTracks(socket.downloadWorker.id, function (err, tracks) {
        for (var i = 0; i < tracks.data.length; i++) {
          tracks.data[i] = tracks.data[i].id;
        }
        socket.downloadWorker.playlistContent = tracks.data;
        socket.downloadWorker.settings.tagPosition = true;
        socket.downloadWorker.settings.addToPath = socket.downloadWorker.artist + " - " + socket.downloadWorker.name;
        async.eachSeries(socket.downloadWorker.playlistContent, function (id, callback) {
          if (socket.downloadWorker.cancelFlag) {
            callback("stop");
            return;
          }
          socket.downloadWorker.settings.playlist = {
            position: socket.downloadWorker.playlistContent.indexOf(id),
            fullSize: socket.downloadWorker.playlistContent.length
          };
          downloadTrack(id, socket.downloadWorker.settings, function (err) {
            if (socket.downloadWorker.countPerAlbum) {
              callback();
              return;
            }
            if (!err) {
              socket.downloadWorker.downloaded++;
            } else {
              socket.downloadWorker.failed++;
            }
            socket.emit("updateQueue", socket.downloadWorker);
            callback();
          });
        }, function (err) {
          if (socket.downloadWorker.countPerAlbum) {
            socket.downloadWorker.downloaded++;
            if (socket.downloadQueue.length > 1 && socket.downloadQueue[1].queueId == socket.downloadWorker.queueId) {
              socket.downloadQueue[1].download = socket.downloadWorker.downloaded;
            }
            socket.emit("updateQueue", socket.downloadWorker);
          }
          console.log("Album finished: " + socket.downloadWorker.name);
          if (socket.downloadWorker && socket.downloadQueue[0] && socket.downloadQueue[0].queueId == socket.downloadWorker.queueId) socket.downloadQueue.shift();
          socket.downloadWorker = null;
          queueWorker();
        });
      });
    }
  }

  socket.on("downloadtrack", function (data) {
    Deezer.getTrack(data.id, function (err, track) {
      if (err) {
        console.log(err);
        return;
      }
      var queueId = "id" + Math.random().toString(36).substring(2);
      var _track = {
        name: track["SNG_TITLE"],
        size: 1,
        downloaded: 0,
        failed: 0,
        queueId: queueId,
        id: track["SNG_ID"],
        type: "track"
      };
      if (track["VERSION"]) _track.name = _track.name + " " + track["VERSION"];
      _track.settings = data.settings || {};
      socket.downloadQueue.push(_track);
      socket.emit("addToQueue", _track);
      queueWorker();
    });
  });

  socket.on("downloadplaylist", function (data) {
    Deezer.getPlaylist(data.id, function (err, playlist) {
      if (err) {
        console.log(err);
        return;
      }
      Deezer.getPlaylistSize(data.id, function (err, size) {
        if (err) {
          console.log(err);
          return;
        }
        var queueId = "id" + Math.random().toString(36).substring(2);
        var _playlist = {
          name: playlist["title"],
          size: size,
          downloaded: 0,
          failed: 0,
          queueId: queueId,
          id: playlist["id"],
          type: "playlist"
        };
        _playlist.settings = data.settings || {};
        socket.downloadQueue.push(_playlist);
        socket.emit("addToQueue", _playlist);
        queueWorker();
      });
    });
  });

  socket.on("downloadalbum", function (data) {
    Deezer.getAlbum(data.id, function (err, album) {
      if (err) {
        console.log(err);
        return;
      }
      Deezer.getAlbumSize(data.id, function (err, size) {
        if (err) {
          console.log(err);
          return;
        }
        var queueId = "id" + Math.random().toString(36).substring(2);
        var _album = {
          name: album["title"],
          label: album["label"],
          artist: album["artist"].name,
          size: size,
          downloaded: 0,
          failed: 0,
          queueId: queueId,
          id: album["id"],
          type: "album"
        };
        _album.settings = data.settings || {};
        socket.downloadQueue.push(_album);
        socket.emit("addToQueue", _album);
        queueWorker();
      });
    });
  });

  socket.on("downloadartist", function (data) {
    Deezer.getArtist(data.id, function (err, artist) {
      if (err) {
        console.log(err);
        return;
      }
      Deezer.getArtistAlbums(data.id, function (err, albums) {
        if (err) {
          console.log(err);
          return;
        }

        var queueId = "id" + Math.random().toString(36).substring(2);
        for (var i = 0; i < albums.data.length; i++) {
          var album = albums.data[i];
          var _album = {
            name: album["title"],
            artist: artist.name,
            downloaded: 0,
            failed: 0,
            queueId: queueId,
            id: album["id"],
            type: "album",
            countPerAlbum: true
          };
          _album.settings = data.settings || {};
          socket.downloadQueue.push(_album);
        }
        var showDl = {
          size: albums.data.length,
          name: artist.name + " (ARTIST)",
          downloaded: 0,
          failed: 0,
          queueId: queueId
        }
        socket.emit("addToQueue", showDl);
        queueWorker();

      });
    });
  });

  socket.on("getChartsTopCountry", function (data) {
    Deezer.getChartsTopCountry(function (err, charts) {
      charts = charts || {};
      if (err) {
        charts.data = [];
      }
      socket.emit("getChartsTopCountry", {charts: charts.data, err: err});
    });
  });

  socket.on("getChartsCountryList", function (data) {
    Deezer.getChartsTopCountry(function (err, charts) {
      charts = charts.data || [];
      var countries = [];
      for (var i = 0; i < charts.length; i++) {
        var obj = {
          country: charts[i].title.replace("Top ", ""),
          picture_small: charts[i].picture_small,
          picture_medium: charts[i].picture_medium,
          picture_big: charts[i].picture_big
        };
        countries.push(obj);
      }
      socket.emit("getChartsCountryList", {countries: countries, selected: data.selected});
    });
  });

  socket.on("getChartsTrackListByCountry", function (data) {
    if (!data.country) {
      socket.emit("getChartsTrackListByCountry", {err: "No country passed"});
      return;
    }

    Deezer.getChartsTopCountry(function (err, charts) {
      charts = charts.data || [];
      var countries = [];
      for (var i = 0; i < charts.length; i++) {
        countries.push(charts[i].title.replace("Top ", ""));
      }

      if (countries.indexOf(data.country) == -1) {
        socket.emit("getChartsTrackListByCountry", {err: "Country not found"});
        return;
      }

      var playlistId = charts[countries.indexOf(data.country)].id;

      Deezer.getPlaylistTracks(playlistId, function (err, tracks) {
        if (err) {
          socket.emit("getChartsTrackListByCountry", {err: err});
          return;
        }
        socket.emit("getChartsTrackListByCountry", {
          playlist: charts[countries.indexOf(data.country)],
          tracks: tracks.data
        });
      });
    });
  });

  socket.on("search", function (data) {
    data.type = data.type || "track";
    if (["track", "playlist", "album", "artist"].indexOf(data.type) == -1) {
      data.type = "track";
    }

    Deezer.search(data.text, data.type, function (err, searchObject) {
      try {
        socket.emit("search", {type: data.type, items: searchObject.data});
      } catch (e){
        socket.emit("search", {type: data.type, items: []});
      }
    });
  });

  socket.on("getInformation", function (data) {
    if (!data.type || (["track", "playlist", "album", "artist"].indexOf(data.type) == -1) || !data.id) {
      socket.emit("getInformation", {err: -1, response: {}, id: data.id});
      return;
    }

    var reqType = data.type.charAt(0).toUpperCase() + data.type.slice(1);

    Deezer["get" + reqType](data.id, function (err, response) {
      if (err) {
        socket.emit("getInformation", {err: "wrong id", response: {}, id: data.id});
        return;
      }
      socket.emit("getInformation", {response: response, id: data.id});
    });
  });

  socket.on("getTrackList", function (data) {
    if (!data.type || (["playlist", "album", "artist"].indexOf(data.type) == -1) || !data.id) {
      socket.emit("getTrackList", {err: -1, response: {}, id: data.id, reqType: data.type});
      return;
    }

    if (data.type == 'artist'){
      Deezer.getArtistAlbums(data.id, function (err, response) {
        if (err) {
          socket.emit("getTrackList", {err: "wrong id", response: {}, id: data.id, reqType: data.type});
          return;
        }
        socket.emit("getTrackList", {response: response, id: data.id, reqType: data.type});
      });
    }else{
      var reqType = data.type.charAt(0).toUpperCase() + data.type.slice(1);

      Deezer["get" + reqType + "Tracks"](data.id, function (err, response) {
        if (err) {
          socket.emit("getTrackList", {err: "wrong id", response: {}, id: data.id, reqType: data.type});
          return;
        }
        socket.emit("getTrackList", {response: response, id: data.id, reqType: data.type});
      });
    }

  });

  socket.on("cancelDownload", function (data) {
    if (!data.queueId) {
      return;
    }

    var cancel = false;

    for (var i = 0; i < socket.downloadQueue.length; i++) {
      if (data.queueId == socket.downloadQueue[i].queueId) {
        socket.downloadQueue.splice(i, 1);
        i--;
        cancel = true;
      }
    }

    if (socket.downloadWorker && socket.downloadWorker.queueId == data.queueId) {
      var cancelSuccess = Deezer.cancelDecryptTrack();
      cancel = cancel || cancelSuccess;
    }


    if (cancelSuccess && socket.downloadWorker) {
      socket.downloadWorker.cancelFlag = true;
    }
    if (cancel) {
      socket.emit("cancelDownload", {queueId: data.queueId});
    }
  });

  socket.on("downloadAlreadyInQueue", function (data) {
    if (data.id) {
      return;
    }
    var isInQueue = checkIfAlreadyInQueue(data.id);
    if (isInQueue) {
      socket.emit("downloadAlreadyInQueue", {alreadyInQueue: true, id: data.id, queueId: isInQueue});
    } else {
      socket.emit("downloadAlreadyInQueue", {alreadyInQueue: false, id: data.id});
    }
  });

  socket.on("loadSettings", function (data) {
    var settings = {
      tracksDownloadLocation: mainFolder
    };
    socket.emit("loadSettings", {settings: settings});
  });

  socket.on("saveSettings", function (data) {
    if (data.settings){
      configFile.downloadLocation = data.settings.tracksDownloadLocation;

      fs.writeFile('./resources/app/config.json', JSON.stringify(configFile, null, 2), function (err) {
        if (err) return console.log(err);

        mainFolder = configFile.downloadLocation;
        initFolders();
        console.log('Settings Updated');
      });
    }
  });

  socket.on("loadDefaultSettings", function (data) {
    configFile.downloadLocation = null;

    fs.writeFile('./config.json', JSON.stringify(configFile, null, 2), function (err) {
      if (err) return console.log(err);

      mainFolder = electronApp.getPath('music') + '\\Deezloader';
      initFolders();

      var settings = {
        tracksDownloadLocation: mainFolder
      };

      socket.emit("loadSettings", {settings: settings});
      console.log('Settings Updated');
    });
  });

  function downloadTrack(id, settings, callback) {
    Deezer.getTrack(id, function (err, track) {
      if (err) {
        callback(err);
        return;
      }

      track.trackSocket = socket;

      settings = settings || {};

      if (track["VERSION"]) track["SNG_TITLE"] += " " + track["VERSION"];

      var metadata = {
        title: removeDiacritics(track["SNG_TITLE"]),
        artist: removeDiacritics(track["ART_NAME"]),
        album: removeDiacritics(track["ALB_TITLE"])
      };

      if (track["PHYSICAL_RELEASE_DATE"]) metadata.year = track["PHYSICAL_RELEASE_DATE"].slice(0, 4);
      if (track["TRACK_NUMBER"]) metadata.trackNumber = track["TRACK_NUMBER"] + "";

      if (settings.tagPosition) {
        metadata.trackNumber = (settings.playlist.position + 1) + "/" + settings.playlist.fullSize;
      }

      if (track["ALB_PICTURE"]) {
        metadata.image = Deezer.albumPicturesHost + track["ALB_PICTURE"] + Deezer.albumPictures.big;
      }

      var filename = metadata.artist + " - " + metadata.title;
      if (settings.filename != "" && settings.filename) {
        filename = settingsRegex(metadata, settings.filename, settings.playlist);
      }

      var filepath = mainFolder + '/';
      if (settings.path) {
        if (settings.path[settings.path.length - 1] != "/") settings.path += "/";
        filepath = settings.path;
        if (!fs.existsSync(filepath)) {
          var newFolder;
          try {
            newFolder = mkdirp.sync(filepath);
          } catch (e) {
            filepath = mainFolder + '/';
          } finally {
            if (!newFolder) {
              filepath = mainFolder + '/';
            }
          }
        }
      }

      if (settings.addToPath) {
        filepath += fixName(settings.addToPath, true) + '/';
      } else {
        if (settings.createArtistFolder) {
          filepath += fixName(metadata.artist, true) + '/';
          if (!fs.existsSync(filepath)) {
            fs.mkdirSync(filepath);
          }
        }

        if (settings.createAlbumFolder) {
          filepath += fixName(metadata.album, true) + '/';
          if (!fs.existsSync(filepath)) {
            fs.mkdirSync(filepath);
          }
        }
      }

      //Create folder if doesn't exist
      if (!fs.existsSync(filepath)) {
        fs.mkdirSync(filepath);
      }

      writePath = filepath + fixName(filename, true) + '.mp3';

      if (fs.existsSync(writePath)) {
        console.log("Already downloaded: " + metadata.artist + ' - ' + metadata.title)
        callback();
        return;
      }

      //Get image #disabled
      if (metadata.image) {
        var imagefile = fs.createWriteStream(mainFolder + fixName(metadata.title, true) + ".jpg");
        http.get(metadata.image, function (response) {
          if (!response) {
            metadata.image = undefined;
            return;
          }
          response.pipe(imagefile);
          metadata.image = (mainFolder + fixName(metadata.title, true) + ".jpg").replace(/\\/g, "/");
        });
      }
	  
      Deezer.decryptTrack(track, function (err, buffer) {
        if (err && err.message == "aborted") {
          socket.downloadWorker.cancelFlag = true;
          callback();
          return;
        }
        if (err) {
          Deezer.hasTrackAlternative(id, function (err, alternative) {
            if (err || !alternative) {
              callback(err);
              return;
            }
            downloadTrack(alternative.id, settings, callback);
          });
          return;
        }

        fs.writeFile(writePath, buffer, function (err) {
          if (err) {
            callback(err);
            return;
          }

          if (settings.createM3UFile && settings.playlist) {
            fs.appendFileSync(filepath + "playlist.m3u", filename + ".mp3\r\n");
          }

          console.log("Downloaded: " + metadata.artist + " - " + metadata.title);

          //Write ID3-Tags
          if (!nodeID3.write(metadata, writePath)) {
            //log
          }
		  
		  //delte temporary cover image #added by b00kay
		  fs.unlinkSync(mainFolder + fixName(metadata.title, true) + ".jpg");

          callback();
        });

      });
    });
  }

  function checkIfAlreadyInQueue(id) {
    var exists = false;
    for (var i = 0; i < socket.downloadQueue.length; i++) {
      if (socket.downloadQueue[i].id == id) {
        exists = socket.downloadQueue[i].queueId;
      }
    }
    if (socket.downloadWorker && (socket.downloadWorker.id == id)) {
      exists = socket.downloadWorker.queueId;
    }
    return exists;
  }
});

var fixName = function (input, file) {
  var regEx = new RegExp('[,/\\\\:*?""<>|]', 'g');
  if (!file) {
    regEx = new RegExp('[/\\\\""<>|]', 'g');
  }
  var fixedName = input.replace(regEx, '_');
  fixedName = removeDiacritics(fixedName);

  return fixedName;
}

function removeDiacritics (str) {

  var defaultDiacriticsRemovalMap = [
    {'base':'A', 'letters':/[\u0041\u24B6\uFF21\u00C0\u00C1\u00C2\u1EA6\u1EA4\u1EAA\u1EA8\u00C3\u0100\u0102\u1EB0\u1EAE\u1EB4\u1EB2\u0226\u01E0\u00C4\u01DE\u1EA2\u00C5\u01FA\u01CD\u0200\u0202\u1EA0\u1EAC\u1EB6\u1E00\u0104\u023A\u2C6F]/g},
    {'base':'AA','letters':/[\uA732]/g},
    {'base':'AE','letters':/[\u00C6\u01FC\u01E2]/g},
    {'base':'AO','letters':/[\uA734]/g},
    {'base':'AU','letters':/[\uA736]/g},
    {'base':'AV','letters':/[\uA738\uA73A]/g},
    {'base':'AY','letters':/[\uA73C]/g},
    {'base':'B', 'letters':/[\u0042\u24B7\uFF22\u1E02\u1E04\u1E06\u0243\u0182\u0181]/g},
    {'base':'C', 'letters':/[\u0043\u24B8\uFF23\u0106\u0108\u010A\u010C\u00C7\u1E08\u0187\u023B\uA73E]/g},
    {'base':'D', 'letters':/[\u0044\u24B9\uFF24\u1E0A\u010E\u1E0C\u1E10\u1E12\u1E0E\u0110\u018B\u018A\u0189\uA779]/g},
    {'base':'DZ','letters':/[\u01F1\u01C4]/g},
    {'base':'Dz','letters':/[\u01F2\u01C5]/g},
    {'base':'E', 'letters':/[\u0045\u24BA\uFF25\u00C8\u00C9\u00CA\u1EC0\u1EBE\u1EC4\u1EC2\u1EBC\u0112\u1E14\u1E16\u0114\u0116\u00CB\u1EBA\u011A\u0204\u0206\u1EB8\u1EC6\u0228\u1E1C\u0118\u1E18\u1E1A\u0190\u018E]/g},
    {'base':'F', 'letters':/[\u0046\u24BB\uFF26\u1E1E\u0191\uA77B]/g},
    {'base':'G', 'letters':/[\u0047\u24BC\uFF27\u01F4\u011C\u1E20\u011E\u0120\u01E6\u0122\u01E4\u0193\uA7A0\uA77D\uA77E]/g},
    {'base':'H', 'letters':/[\u0048\u24BD\uFF28\u0124\u1E22\u1E26\u021E\u1E24\u1E28\u1E2A\u0126\u2C67\u2C75\uA78D]/g},
    {'base':'I', 'letters':/[\u0049\u24BE\uFF29\u00CC\u00CD\u00CE\u0128\u012A\u012C\u0130\u00CF\u1E2E\u1EC8\u01CF\u0208\u020A\u1ECA\u012E\u1E2C\u0197]/g},
    {'base':'J', 'letters':/[\u004A\u24BF\uFF2A\u0134\u0248]/g},
    {'base':'K', 'letters':/[\u004B\u24C0\uFF2B\u1E30\u01E8\u1E32\u0136\u1E34\u0198\u2C69\uA740\uA742\uA744\uA7A2]/g},
    {'base':'L', 'letters':/[\u004C\u24C1\uFF2C\u013F\u0139\u013D\u1E36\u1E38\u013B\u1E3C\u1E3A\u0141\u023D\u2C62\u2C60\uA748\uA746\uA780]/g},
    {'base':'LJ','letters':/[\u01C7]/g},
    {'base':'Lj','letters':/[\u01C8]/g},
    {'base':'M', 'letters':/[\u004D\u24C2\uFF2D\u1E3E\u1E40\u1E42\u2C6E\u019C]/g},
    {'base':'N', 'letters':/[\u004E\u24C3\uFF2E\u01F8\u0143\u00D1\u1E44\u0147\u1E46\u0145\u1E4A\u1E48\u0220\u019D\uA790\uA7A4]/g},
    {'base':'NJ','letters':/[\u01CA]/g},
    {'base':'Nj','letters':/[\u01CB]/g},
    {'base':'O', 'letters':/[\u004F\u24C4\uFF2F\u00D2\u00D3\u00D4\u1ED2\u1ED0\u1ED6\u1ED4\u00D5\u1E4C\u022C\u1E4E\u014C\u1E50\u1E52\u014E\u022E\u0230\u00D6\u022A\u1ECE\u0150\u01D1\u020C\u020E\u01A0\u1EDC\u1EDA\u1EE0\u1EDE\u1EE2\u1ECC\u1ED8\u01EA\u01EC\u00D8\u01FE\u0186\u019F\uA74A\uA74C]/g},
    {'base':'OI','letters':/[\u01A2]/g},
    {'base':'OO','letters':/[\uA74E]/g},
    {'base':'OU','letters':/[\u0222]/g},
    {'base':'P', 'letters':/[\u0050\u24C5\uFF30\u1E54\u1E56\u01A4\u2C63\uA750\uA752\uA754]/g},
    {'base':'Q', 'letters':/[\u0051\u24C6\uFF31\uA756\uA758\u024A]/g},
    {'base':'R', 'letters':/[\u0052\u24C7\uFF32\u0154\u1E58\u0158\u0210\u0212\u1E5A\u1E5C\u0156\u1E5E\u024C\u2C64\uA75A\uA7A6\uA782]/g},
    {'base':'S', 'letters':/[\u0053\u24C8\uFF33\u1E9E\u015A\u1E64\u015C\u1E60\u0160\u1E66\u1E62\u1E68\u0218\u015E\u2C7E\uA7A8\uA784]/g},
    {'base':'T', 'letters':/[\u0054\u24C9\uFF34\u1E6A\u0164\u1E6C\u021A\u0162\u1E70\u1E6E\u0166\u01AC\u01AE\u023E\uA786]/g},
    {'base':'TZ','letters':/[\uA728]/g},
    {'base':'U', 'letters':/[\u0055\u24CA\uFF35\u00D9\u00DA\u00DB\u0168\u1E78\u016A\u1E7A\u016C\u00DC\u01DB\u01D7\u01D5\u01D9\u1EE6\u016E\u0170\u01D3\u0214\u0216\u01AF\u1EEA\u1EE8\u1EEE\u1EEC\u1EF0\u1EE4\u1E72\u0172\u1E76\u1E74\u0244]/g},
    {'base':'V', 'letters':/[\u0056\u24CB\uFF36\u1E7C\u1E7E\u01B2\uA75E\u0245]/g},
    {'base':'VY','letters':/[\uA760]/g},
    {'base':'W', 'letters':/[\u0057\u24CC\uFF37\u1E80\u1E82\u0174\u1E86\u1E84\u1E88\u2C72]/g},
    {'base':'X', 'letters':/[\u0058\u24CD\uFF38\u1E8A\u1E8C]/g},
    {'base':'Y', 'letters':/[\u0059\u24CE\uFF39\u1EF2\u00DD\u0176\u1EF8\u0232\u1E8E\u0178\u1EF6\u1EF4\u01B3\u024E\u1EFE]/g},
    {'base':'Z', 'letters':/[\u005A\u24CF\uFF3A\u0179\u1E90\u017B\u017D\u1E92\u1E94\u01B5\u0224\u2C7F\u2C6B\uA762]/g},
    {'base':'a', 'letters':/[\u0061\u24D0\uFF41\u1E9A\u00E0\u00E1\u00E2\u1EA7\u1EA5\u1EAB\u1EA9\u00E3\u0101\u0103\u1EB1\u1EAF\u1EB5\u1EB3\u0227\u01E1\u00E4\u01DF\u1EA3\u00E5\u01FB\u01CE\u0201\u0203\u1EA1\u1EAD\u1EB7\u1E01\u0105\u2C65\u0250]/g},
    {'base':'aa','letters':/[\uA733]/g},
    {'base':'ae','letters':/[\u00E6\u01FD\u01E3]/g},
    {'base':'ao','letters':/[\uA735]/g},
    {'base':'au','letters':/[\uA737]/g},
    {'base':'av','letters':/[\uA739\uA73B]/g},
    {'base':'ay','letters':/[\uA73D]/g},
    {'base':'b', 'letters':/[\u0062\u24D1\uFF42\u1E03\u1E05\u1E07\u0180\u0183\u0253]/g},
    {'base':'c', 'letters':/[\u0063\u24D2\uFF43\u0107\u0109\u010B\u010D\u00E7\u1E09\u0188\u023C\uA73F\u2184]/g},
    {'base':'d', 'letters':/[\u0064\u24D3\uFF44\u1E0B\u010F\u1E0D\u1E11\u1E13\u1E0F\u0111\u018C\u0256\u0257\uA77A]/g},
    {'base':'dz','letters':/[\u01F3\u01C6]/g},
    {'base':'e', 'letters':/[\u0065\u24D4\uFF45\u00E8\u00E9\u00EA\u1EC1\u1EBF\u1EC5\u1EC3\u1EBD\u0113\u1E15\u1E17\u0115\u0117\u00EB\u1EBB\u011B\u0205\u0207\u1EB9\u1EC7\u0229\u1E1D\u0119\u1E19\u1E1B\u0247\u025B\u01DD]/g},
    {'base':'f', 'letters':/[\u0066\u24D5\uFF46\u1E1F\u0192\uA77C]/g},
    {'base':'g', 'letters':/[\u0067\u24D6\uFF47\u01F5\u011D\u1E21\u011F\u0121\u01E7\u0123\u01E5\u0260\uA7A1\u1D79\uA77F]/g},
    {'base':'h', 'letters':/[\u0068\u24D7\uFF48\u0125\u1E23\u1E27\u021F\u1E25\u1E29\u1E2B\u1E96\u0127\u2C68\u2C76\u0265]/g},
    {'base':'hv','letters':/[\u0195]/g},
    {'base':'i', 'letters':/[\u0069\u24D8\uFF49\u00EC\u00ED\u00EE\u0129\u012B\u012D\u00EF\u1E2F\u1EC9\u01D0\u0209\u020B\u1ECB\u012F\u1E2D\u0268\u0131]/g},
    {'base':'j', 'letters':/[\u006A\u24D9\uFF4A\u0135\u01F0\u0249]/g},
    {'base':'k', 'letters':/[\u006B\u24DA\uFF4B\u1E31\u01E9\u1E33\u0137\u1E35\u0199\u2C6A\uA741\uA743\uA745\uA7A3]/g},
    {'base':'l', 'letters':/[\u006C\u24DB\uFF4C\u0140\u013A\u013E\u1E37\u1E39\u013C\u1E3D\u1E3B\u017F\u0142\u019A\u026B\u2C61\uA749\uA781\uA747]/g},
    {'base':'lj','letters':/[\u01C9]/g},
    {'base':'m', 'letters':/[\u006D\u24DC\uFF4D\u1E3F\u1E41\u1E43\u0271\u026F]/g},
    {'base':'n', 'letters':/[\u006E\u24DD\uFF4E\u01F9\u0144\u00F1\u1E45\u0148\u1E47\u0146\u1E4B\u1E49\u019E\u0272\u0149\uA791\uA7A5]/g},
    {'base':'nj','letters':/[\u01CC]/g},
    {'base':'o', 'letters':/[\u006F\u24DE\uFF4F\u00F2\u00F3\u00F4\u1ED3\u1ED1\u1ED7\u1ED5\u00F5\u1E4D\u022D\u1E4F\u014D\u1E51\u1E53\u014F\u022F\u0231\u00F6\u022B\u1ECF\u0151\u01D2\u020D\u020F\u01A1\u1EDD\u1EDB\u1EE1\u1EDF\u1EE3\u1ECD\u1ED9\u01EB\u01ED\u00F8\u01FF\u0254\uA74B\uA74D\u0275]/g},
    {'base':'oi','letters':/[\u01A3]/g},
    {'base':'ou','letters':/[\u0223]/g},
    {'base':'oo','letters':/[\uA74F]/g},
    {'base':'p','letters':/[\u0070\u24DF\uFF50\u1E55\u1E57\u01A5\u1D7D\uA751\uA753\uA755]/g},
    {'base':'q','letters':/[\u0071\u24E0\uFF51\u024B\uA757\uA759]/g},
    {'base':'r','letters':/[\u0072\u24E1\uFF52\u0155\u1E59\u0159\u0211\u0213\u1E5B\u1E5D\u0157\u1E5F\u024D\u027D\uA75B\uA7A7\uA783]/g},
    {'base':'s','letters':/[\u0073\u24E2\uFF53\u00DF\u015B\u1E65\u015D\u1E61\u0161\u1E67\u1E63\u1E69\u0219\u015F\u023F\uA7A9\uA785\u1E9B]/g},
    {'base':'t','letters':/[\u0074\u24E3\uFF54\u1E6B\u1E97\u0165\u1E6D\u021B\u0163\u1E71\u1E6F\u0167\u01AD\u0288\u2C66\uA787]/g},
    {'base':'tz','letters':/[\uA729]/g},
    {'base':'u','letters':/[\u0075\u24E4\uFF55\u00F9\u00FA\u00FB\u0169\u1E79\u016B\u1E7B\u016D\u00FC\u01DC\u01D8\u01D6\u01DA\u1EE7\u016F\u0171\u01D4\u0215\u0217\u01B0\u1EEB\u1EE9\u1EEF\u1EED\u1EF1\u1EE5\u1E73\u0173\u1E77\u1E75\u0289]/g},
    {'base':'v','letters':/[\u0076\u24E5\uFF56\u1E7D\u1E7F\u028B\uA75F\u028C]/g},
    {'base':'vy','letters':/[\uA761]/g},
    {'base':'w','letters':/[\u0077\u24E6\uFF57\u1E81\u1E83\u0175\u1E87\u1E85\u1E98\u1E89\u2C73]/g},
    {'base':'x','letters':/[\u0078\u24E7\uFF58\u1E8B\u1E8D]/g},
    {'base':'y','letters':/[\u0079\u24E8\uFF59\u1EF3\u00FD\u0177\u1EF9\u0233\u1E8F\u00FF\u1EF7\u1E99\u1EF5\u01B4\u024F\u1EFF]/g},
    {'base':'z','letters':/[\u007A\u24E9\uFF5A\u017A\u1E91\u017C\u017E\u1E93\u1E95\u01B6\u0225\u0240\u2C6C\uA763]/g}
  ];

  for(var i=0; i<defaultDiacriticsRemovalMap.length; i++) {
    str = str.replace(defaultDiacriticsRemovalMap[i].letters, defaultDiacriticsRemovalMap[i].base);
  }

  return str;

}

function initFolders() {
  // Define the vars
  //var coverArtDir = mainFolder + "/img";
  var mp3FilesDir = mainFolder;

  // Create main folder
  if (!fs.existsSync(mainFolder)) {
    fs.mkdirSync(mainFolder)
  }

  //## disabled by b00kay
  // Check if folder for covers exists. Create if not
  /*if (fs.existsSync(coverArtDir)) {

    // Delete each file inside the folder
    fs.readdirSync(coverArtDir).forEach(function (file, index) {
      var curPath = coverArtDir + "/" + file;
      fs.unlinkSync(curPath);
    });

    // Delete the folder and make a new one
    fs.rmdir(coverArtDir, function (err) {
      fs.mkdirSync(coverArtDir);
    });
  } else {
    fs.mkdirSync(coverArtDir);
  }
  */

  // Create if folder for audio files does not exist
  if (!fs.existsSync(mp3FilesDir)) {
    fs.mkdirSync(mp3FilesDir)
  }
}

function settingsRegex(metadata, filename, playlist) {
  filename = filename.replace(/%title%/g, metadata.title);
  filename = filename.replace(/%album%/g, metadata.album);
  filename = filename.replace(/%artist%/g, metadata.artist);
  if (playlist) {
    filename = filename.replace(/%number%/g, pad(playlist.position + 1, playlist.fullSize.toString().length));
  }
  return filename;
}

function pad(str, max) {
  str = str.toString();
  return str.length < max ? pad("0" + str, max) : str;
}

process.on('uncaughtException', function (err) {
  console.trace(err);
});
