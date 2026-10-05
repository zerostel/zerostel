# Renders docs/assets/demo.gif with VHS (https://github.com/charmbracelet/vhs).
#
# Needs vhs, ttyd, ffmpeg, git and Node 20+. Run from the repo root after
# `npm run build`:
#
#   vhs docs/demo/demo.tape
#
# The session is an example: scripts/demo-setup.mjs plays one agent turn
# through the real hook handler in a throwaway project under /tmp.

Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 18
Set Width 1280
Set Height 720
Set Padding 28
Set Margin 24
Set MarginFill "#5B5BD6"
Set WindowBar Colorful
Set BorderRadius 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type 'eval "$(node scripts/demo-setup.mjs)" && clear'
Enter
Sleep 15s
Show

Type "zerostel log"
Sleep 400ms
Enter
Sleep 6s

Type "ls src"
Sleep 300ms
Enter
Sleep 1.5s

Type "zerostel undo"
Sleep 400ms
Enter
Sleep 3s
Type "y"
Enter
Sleep 2.5s

Type "ls src"
Sleep 300ms
Enter
Sleep 2s

Type "zerostel report --share"
Sleep 400ms
Enter
Sleep 4s
