const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid');
const { rootCertificates } = require('node:tls');

async function main() {

  //Server gets an id on boot
  const serverId = Date.now();

  // open the database file
  const db = await open({
    filename: 'Awful-Author.db',
    driver: sqlite3.Database
  });

  await db.exec('DELETE FROM games');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomId TEXT,
        story TEXT,
        contribution TEXT
    );
  `);
  
  const app = express();
  const path = require('path');
  app.use(express.static(path.join(__dirname, 'public')));

  let io;
  let server;
  try {// If running on server
    const httpsOptions = {
      key: fs.readFileSync("C:/Certs/awful-authors.mce123.co.uk_key.key"),    // your private key
      cert: fs.readFileSync("C:/Certs/awful-authors.mce123.co.uk_cert/awful-authors.mce123.co.uk.crt"),   // your domain cert
      ca: fs.readFileSync("C:/Certs/awful-authors.mce123.co.uk_cert/awful-authors.mce123.co.uk.ca-bundle") // intermediate CAs
    };

    server = https.createServer(httpsOptions, app);
    io = new Server(server, {
      connectionStateRecovery: {}
    });
  } catch (error) {//if running on laptop
    server = createServer(app);
    io = new Server(server, {
      connectionStateRecovery: {}
    });
  }

  // game settings
  const MAX_PLAYERS = 8;
  const TIME_PER_WORD = 3000;
  const MIN_WORDS = 1;
  const MAX_WORDS = 10;
  const MIN_ROUNDS = 1;
  const MAX_ROUNDS = 100;

  // story and prompts
  const storyChars = /^[ abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!"£$%^&*()\-\_=+\[\]{}~#:;@?\/,.\|¬]+$/;
  const storyPrompts = ['medieval times', 'the near future', 'a faraway future', 'prehistory', 'a dangerous discovery', 
    'a disturbing discovery', 'an ancient promise', 'a forgotten promise', 'a lost memory', 'loyal to a fault', 'freedom?', 
    'true courage', 'your greatest enemy', 'a letter never sent', 'the wrong suspect', 'a second chance', 'the one that got away', 
    'an unknown land', 'a fantastical land', 'a cold land', 'best... enemies?'];
  const numPrompts = storyPrompts.length;

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  const gamesData = {};

  io.on('connection', (socket) => {
    //Send the server Id to the client
    socket.emit("server_id", serverId);

    // user creating a new room (game)
    socket.on("createGame", async (nickname) => {
      if (!validateNickname(nickname)){
        socket.emit("error", "Invalid data received.");
        return;
      };
      
      // creates new gamesData[roomCode] object
      const roomCode = uuidv4();
      const userId = uuidv4();
      initRoomData(roomCode, userId, nickname);

      socket.join(roomCode);
      socket.emit("joinGame", userId, roomCode, [nickname], numPrompts);
    });

    // user joining a room (game)
    socket.on("joinGame", async (nickname, roomCode) => {
      if (!validateNickname(nickname) || !validateUUID(roomCode)){
        socket.emit("error", "Invalid data received.");
        return;
      };

      let userId;
      let roomExists = gamesData.hasOwnProperty(roomCode);
      let sessionExists = false;
      let gameExists = false;
      let gameFull = false;

      // no room with that code
      if (!roomExists) {
        socket.emit("error", "Room with that code does not exist.");
        return;
      }

      // room with that code exists
      else {
        sessionExists = roomExists && gamesData[roomCode].players.hasOwnProperty(socket.handshake.auth.userId);
        gameExists = gamesData[roomCode].wordLimit !== null;
        gameFull = Object.keys(gamesData[roomCode].players).length == MAX_PLAYERS;

        // new player joining an existing room
        if (!sessionExists) {

          // ensuring player cannot join unavailable room
          if (gameExists) {
            socket.emit("error", "This game has already started.");
            return;
          }
          if (gameFull) {
            socket.emit("error", "This game has reached max players.");
            return;
          }

          // lobby available for new player to join
          userId = uuidv4();
          gamesData[roomCode].players[userId] = {
            nickname: [nickname],
            charCount: 0,
            spaceCount: 0
          };
          socket.to(roomCode).emit('lobbyJoin', nickname); 
        }

        // player can rejoin after hard disconnect
        else {
          userId = socket.handshake.auth.userId;
          let nick = gamesData[roomCode].players[userId].nickname;
          socket.emit("error", `Session found, reconnecting you now as ${nick}.`);
        };
      };

      socket.join(roomCode);

      // list of users connected to lobby
      const nicknames = Object.values(gamesData[roomCode].players).map(player => player.nickname);
      socket.emit("joinGame", userId, roomCode, nicknames, numPrompts);

      //reconnecting to a game
      if (sessionExists && gameExists) {
        // this will need to be for PROPER reconnects
        socket.emit("initGame", gamesData[roomCode].wordLimit, gamesData[roomCode].roundLimit, gamesData[roomCode].prompt, nicknames, playerIds, true);

        //send the user the id of the current player
        const currentIndex = gamesData[roomCode].currentPlayerIndex;
        socket.emit("startGame", playerIds[currentIndex]);
        socket.emit("turnStart", playerIds[currentIndex], gamesData[roomCode].wordLimit);

        //send the user the complete story realtime
        const storyRow = await db.get('SELECT story FROM games WHERE roomId = ?', roomCode);
        const storyDb = storyRow ? storyRow.story : "";
        const currentRoundStory = gamesData[roomCode].currentRoundStory;
        const story = storyDb + currentRoundStory;

        if (gamesData[roomCode].gameOver === true) {
          const contributions = await db.get('SELECT contribution FROM games WHERE roomId = ?', roomCode);
          socket.emit("endGame", story, gamesData[roomCode].prompt, nicknames, contributions.contribution);
        } else {
          socket.emit("gameRecovery", gamesData[roomCode].currentRound+1, story);
        };

        return;
      };
    });

    // syncing up game settings changes in lobby for all clients in a room
    socket.on("lobbyValChange", (roomCode, element, value) => {
      socket.to(roomCode).emit("lobbyValChange", element, value);
    });

    // game begins in room
    socket.on("initGame", async (roomCode, wordCount, roundCount, promptVal) => {
      if (!validateUUID(roomCode) || !validateCount(wordCount, MIN_WORDS, MAX_WORDS) || !validateCount(roundCount, MIN_ROUNDS, MAX_ROUNDS)){
        socket.emit("error", "Invalid data received.");
        return;
      };

      if (!checkRoomExists(socket, roomCode)) return;
      
      gamesData[roomCode].wordLimit = parseInt(wordCount);
      gamesData[roomCode].roundLimit = roundCount;
      gamesData[roomCode].prompt = randPrompt(promptVal);

      await db.run('DELETE FROM games WHERE roomId = ?', roomCode);
      await db.run('INSERT INTO games (roomId, story, contribution) VALUES (?, ?, ?)', roomCode, "", "");
      
      playerIds = Object.keys(gamesData[roomCode].players);
      playerNicknames = Object.values(gamesData[roomCode].players).map(player => player.nickname);
      io.to(roomCode).emit("initGame", wordCount, roundCount, gamesData[roomCode].prompt, playerNicknames, playerIds, false);
    });

    // one of the players clicks start game
    socket.on("startGame", (roomCode) => {
      if (!validateUUID(roomCode)){
        socket.emit("error", "Invalid data received.");
        return;
      };

      if (!checkRoomExists(socket, roomCode)) return;
      
      gamesData[roomCode].currentPlayerIndex = 0;
      //get all clientId's of the players for working out turns
      io.to(roomCode).emit("startGame", playerIds[0]);

      gamesData[roomCode].timerEnd = Date.now() + gamesData[roomCode].wordLimit * TIME_PER_WORD;
      scheduleTurnEnd(roomCode);
      io.to(roomCode).emit("turnStart", playerIds[0], gamesData[roomCode].wordLimit);
    });
    
    //Server receives a key press from the current player
    socket.on("newChar", async (key, roomCode) => {
      let playerIds = Object.keys(gamesData[roomCode].players);
      let currentPlayerIndex = gamesData[roomCode].currentPlayerIndex;
      let player = playerIds[currentPlayerIndex];
      let p = gamesData[roomCode].players[player] //shallow copy of the player object for readability

      if (!validateUUID(roomCode) || !validateKey(key)) {
        socket.emit("error", "Invalid data received.");
        return;
      };

      //check if server is ready
      if (!checkRoomExists(socket, roomCode)) return;
      if (gamesData[roomCode].gameOver) return;

      //otherwise, work out what to do depending on what character they enter
      switch (key) {
        case " ":
          //if the last entry was a space, dont allow another one
          if (gamesData[roomCode].currentRoundStory[p.charCount-1] === " ") {
            break;
          };
          gamesData[roomCode].currentRoundStory += key;
          p.spaceCount += 1;
          p.charCount += 1;
          io.to(roomCode).emit("newChar", key);
          break;
        case "¬":
          //make sure that they have characters down on their turn to delete
          if (p.charCount > 0) {
            if (gamesData[roomCode].currentRoundStory[p.charCount-1] === " "){
              p.spaceCount -= 1;
            };
            gamesData[roomCode].currentRoundStory = gamesData[roomCode].currentRoundStory.slice(0, -1);
            p.charCount -= 1;
            io.to(roomCode).emit("newChar", key);
            break;
          };
          break;
        case "|":
          //if the last entry was a new line, do nothing
          gamesData[roomCode].currentRoundStory += " ";
          p.charCount += 1;
          p.spaceCount += gamesData[roomCode].wordLimit;
          io.to(roomCode).emit("newChar", " ");
          break;
        default:
          gamesData[roomCode].currentRoundStory += key;
          p.charCount+=1;
          io.to(roomCode).emit("newChar", key);
      };

      //if the player has used up their amount of words, change whos turn it is
      if (p.spaceCount >= gamesData[roomCode].wordLimit){
        //reset counters
        p.charCount = 0;
        p.spaceCount = 0;
        turnEnd(roomCode);
      }
    });

    // someone in a room wants to play again
    socket.on("playAgain", async (roomCode, userId, nickname) => {
      if (!validateUUID(roomCode) || !validateUUID(userId) || !validateNickname(nickname)){
        socket.emit("error", "Invalid data received.");
        return;
      };

      // empty story for that room in db
      await db.run('UPDATE games SET story = ? WHERE roomId = ?', "", roomCode);

      // reset room gamesData, init using player who pressed button
      delete gamesData[roomCode];
      initRoomData(roomCode, userId, nickname);

      // client-side reset
      io.to(roomCode).emit('playAgain');

      // begin playing again
      socket.emit('joinGame', userId, roomCode, [nickname], numPrompts); // only for client that pressed button
      socket.to(roomCode).emit('createGame', roomCode); // for all clients except one who pressed button
    });

    // updates handshake after initial setup
    socket.on('updateAuth', (data) => {
      socket.handshake.auth = data;
    });

    // removes data of empty rooms and removes player data if player disconnected during lobby
    socket.on("disconnecting", async () => {
      // find room that dced client was in
      for (const roomId of socket.rooms){
        if (roomId !== socket.id){
          const numConnected = io.of("/").adapter.rooms.get(roomId)?.size || 0;

          // player was last to leave room, so room data removed
          if (numConnected === 1) {
            if (gamesData[roomId].timerHandle) {
              clearTimeout(gamesData[roomId].timerHandle)
            }
            delete gamesData[roomId];
            await db.run('DELETE FROM games WHERE roomId = ?', roomId);
          }

          // player dced from lobby (wordLimit not set yet in lobby)
          else if (gamesData[roomId].wordLimit === null) {
            delete gamesData[roomId].players[socket.handshake.auth.userId];
            let nicks = Object.values(gamesData[roomId].players).map(player => player.nickname);
            io.to(roomId).emit('lobbyLeave', nicks);
          };
        };
      };
    });
  });

  server.listen(3000);

  /*
  -----------------------------------------------------------------------------
  HELPER FUNCTIONS ------------------------------------------------------------
  -----------------------------------------------------------------------------
  */

  async function turnEnd(roomCode) {
    let currentPlayerIndex = gamesData[roomCode].currentPlayerIndex;
    let playerIds = Object.keys(gamesData[roomCode].players)
    let player = playerIds[currentPlayerIndex];

    gamesData[roomCode].players[player].charCount = 0;
    gamesData[roomCode].players[player].spaceCount = 0;

    //update story in db
    const storyRow = await db.get('SELECT story FROM games WHERE roomId = ?', roomCode);
    const previousStory = storyRow ? storyRow.story : "";
    const updatedStory = previousStory + gamesData[roomCode].currentRoundStory;
    await db.run('UPDATE games SET story = ? WHERE roomId = ?', updatedStory, roomCode);

    //update contributions in db
    let wordContributions = gamesData[roomCode].currentRoundStory.trim().split(/[\s|]+/);
    let contributionAmount = 0;
    // If string ends with space, every word has a space after it
    if (gamesData[roomCode].currentRoundStory.endsWith(" ")) {
      contributionAmount = wordContributions.length;
    } else {
      // Otherwise, last word has no space after it
      contributionAmount = wordContributions.length - 1;
    }
    let playerContribution = (currentPlayerIndex.toString()).repeat(contributionAmount);
    const contributionRow = await db.get('SELECT contribution FROM games WHERE roomId = ?', roomCode);
    const previousContribution = contributionRow ? contributionRow.contribution : "";
    const updatedContribution = previousContribution + playerContribution;
    await db.run('UPDATE games SET contribution = ? WHERE roomId = ?', updatedContribution, roomCode);

    //Give the next player an extra word if the last player did not finish theirs.
    if (gamesData[roomCode].wordLimitChanged == true){
      gamesData[roomCode].wordLimit -= 1;
      gamesData[roomCode].wordLimitChanged = false;
    }

    let finalChar = gamesData[roomCode].currentRoundStory[gamesData[roomCode].currentRoundStory.length-1];
    if (finalChar != " " && finalChar != "|"){
      gamesData[roomCode].wordLimit += 1;
      gamesData[roomCode].wordLimitChanged = true;
    }

    gamesData[roomCode].currentRoundStory = "";

    //update whos turn it is and emit that id as well as check for end of round
    if (currentPlayerIndex >= playerIds.length-1) {
      currentPlayerIndex = 0;
      gamesData[roomCode].currentRound += 1;
      if (gamesData[roomCode].currentRound < gamesData[roomCode].roundLimit){
        io.to(roomCode).emit("roundEnd", gamesData[roomCode].currentRound+1);
      };
    }
    else {
      currentPlayerIndex += 1;
    };
    gamesData[roomCode].currentPlayerIndex = currentPlayerIndex;

    //if the currentRound equals the set roundLimit, then end the game
    if (gamesData[roomCode].currentRound >= gamesData[roomCode].roundLimit){
      const finalStory = await db.get('SELECT story FROM games WHERE roomId = ?', roomCode);
      const nicknames = Object.values(gamesData[roomCode].players).map(player => player.nickname);
      const contributions = await db.get('SELECT contribution FROM games WHERE roomId = ?', roomCode);
      io.to(roomCode).emit("endGame", finalStory.story, gamesData[roomCode].prompt, nicknames, contributions.contribution);
      if (gamesData[roomCode].timerHandle) {
        clearTimeout(gamesData[roomCode].timerHandle);
      }
      gamesData[roomCode].gameOver = true;
    }
    else {
      //Send a new timer for the new turn
      gamesData[roomCode].timerEnd = Date.now() + gamesData[roomCode].wordLimit * 3000;
      scheduleTurnEnd(roomCode);
      io.to(roomCode).emit("turnStart", playerIds[currentPlayerIndex], gamesData[roomCode].wordLimit);
    };
  };

  async function scheduleTurnEnd(roomCode){
    const now = Date.now();
    const timeLeft = gamesData[roomCode].timerEnd - now;

    if (gamesData[roomCode].timerHandle) {
      clearTimeout(gamesData[roomCode].timerHandle);
    };

    if (timeLeft <= 0) {
      // Time already passed - end immediately
      turnEnd(roomCode);
    } 
    else {
      gamesData[roomCode].timerHandle = setTimeout(() => {
        turnEnd(roomCode);
      }, timeLeft);
    };
  };

  function checkRoomExists(socket, roomCode) {
    if (!gamesData.hasOwnProperty(roomCode)) {
      socket.emit("error", "Room no longer exists. Everyone in the room left, or server may have restarted.");
      return false;
    };
    return true;
  };

  function validateNickname(nick) {
    return typeof nick === 'string' && /^[a-zA-Z0-9_ ]{2,14}$/.test(nick);
  };

  function validateUUID(code) {
    return typeof code === 'string' && /^[a-zA-Z0-9\-]{1,36}$/.test(code); // UUID-like
  };

  function validateCount(val, min, max) {
    const num = Number(val);
    return Number.isInteger(num) && num >= min && num <= max;
  };

  function validateKey(key) {
    return storyChars.test(key);
  };

  function randPrompt(index) {
    if (!Number.isInteger(index) || index === -1 || index > numPrompts){
      return "";
    };
    return storyPrompts[index];
  };

  function initRoomData(roomCode, userId, nickname){
    gamesData[roomCode] = {
      players: {
        [userId]: {
          nickname: [nickname],
          charCount: 0,
          spaceCount: 0
        }
      },
      wordLimit: null,
      roundLimit: null,
      prompt: "",
      currentRound: 0,
      currentPlayerIndex: null,
      currentRoundStory: "",
      gameOver: false,
      timerEnd: null,
      timerHandle: null,
      wordLimitChanged: false
    };
  };
};

main();