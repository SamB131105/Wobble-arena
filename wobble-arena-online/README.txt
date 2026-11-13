QUICK SIX
=========
Keyboard reaction games for 2 to 6 friends, played in a web browser.

WHAT IS IN THIS FOLDER
  server.js            the game server (it runs every game and does all the timing)
  public/index.html    the web page players see

TRY IT ON YOUR OWN PC
  1. Install Node.js (the "LTS" version) from https://nodejs.org
  2. Open this folder, click the address bar, type  cmd  and press Enter.
  3. In the black window type:   node server.js
  4. Open a browser and go to:   http://localhost:3000
  5. Click "Create a room". Open a second browser tab on the same address
     and join with the four-letter code to see two players at once.
  To stop the server, close the black window.

PLAYING WITH FRIENDS
  Same house / same Wi-Fi: friends open  http://YOUR-PC-ADDRESS:3000
  (find the address by typing  ipconfig  in the black window and reading
  the "IPv4 Address" line, for example http://192.168.1.23:3000).
  Windows may ask whether to allow Node.js through the firewall: say yes.

  Over the internet: the server has to run somewhere public (a web host
  that can run Node.js apps). Upload this whole folder, set the start
  command to  node server.js , and share the web address the host gives you.
  The server reads the PORT setting that hosts provide automatically.

SOLO VS BOTS
  "Solo vs bots" on the first screen puts you against three computer players
  in any of the 14 games, or in a full Party.
  Each game has its own bot level, saved in your browser. Finish first and
  that game's bots go up a level (faster reactions, fewer mistakes, quicker
  mashing). Finish last and they drop one. There is no top level.

YOUR CHARACTER
  "Edit character" on the first screen lets you choose skin, hair style,
  hair colour, eyes and shirt. It is saved in your browser.

PLAYING STRANGERS
  Quick Match   joins a public room of up to 6. A random game starts
                12 seconds after a second player arrives, then another, and so on.
  Party Match   the same, but a full 5-round party with cards.
  Both only work when other people are on the site at the same time.
  While waiting, press 1 to 6 for emotes, or SPACE for a reaction practice.

RANKS
  Public matches move your rank up or down (everyone starts at 1000).
  Private rooms never change it.
  Ranks are kept in each player's own browser as a card signed by the server,
  so there is no database to run. Two things to know:
    - On your web host, add an environment variable called SECRET with any
      long random text. Without it, everyone's rank resets when the server restarts.
    - A player who clears their browser data starts again at 1000, and
      a player who quits before a result is shown does not lose rank.

PARTY MODE
  The host picks 5 or 10 rounds. Every round is a mystery game.
  Points by finishing place: 10, 7, 5, 3, 2, 1. Your podium rises as you score.
  Before the party everyone secretly picks 2 of these cards (one use each):
    Double   doubles your points for one game (played before you know the game)
    Halve    halves one rival's points for one game (revealed with the scores)
    Shield   blocks one Halve played on you that round
  The server holds the cards, so nobody can see what has been played.

THE 14 GAMES
  Quick Draw       SPACE when you see DRAW!
  Fly Swat         Arrow keys. First to swat each fly scores. Wasps cost 2.
  Penalty Keeper   Left / Right / Up. Everyone faces the same 7 shots.
  Mash Dash        Hammer Z and X in turn to sprint 100 m.
  Red Light        Mash Z and X, but freeze when the light goes red.
  Hot Potato       Press the arrow shown to pass it on before it blows. (2+ players)
  Copy Cat         Repeat a growing sequence of arrows.
  Word Dash        Type the word first.
  Last Seat        SPACE when the music stops. Slowest is out. (2+ players)
  Stop the Clock   Stop a hidden clock on the target time.
  Colour Clash     Press the arrow for the ink colour, not the word.
  Quick Maths      Pick the right answer first.
  Odd One Out      Spot the one that is different.
  Opposite Day     Press the opposite arrow, unless it says SAME.
  Press M to mute (except while typing in Word Dash).

ANTI-CHEAT
  - The server picks every random moment and never tells browsers in advance.
  - The server times every key press itself.
  - Reactions faster than 0.1 seconds are treated as a false start.
  - Mash Dash ignores held keys and anything faster than 22 presses a second.
  - Each player gets a small, capped allowance for their connection delay.
  This stops casual cheating between friends. It cannot stop a determined
  programmer who writes a bot.
