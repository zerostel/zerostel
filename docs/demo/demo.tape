# The demo (see README.md here): one agent turn deletes src/legacy with rm -rf and breaks
# the tests, and `zerostel undo` brings it back. It runs the real npm package
# inside the container, so the paths on screen are /tmp/... and nothing else.
#
#   docker run --rm -v "${PWD}:/vhs" zerostel-vhs demo.tape

Output raw.mp4

Require npx

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 32
Set Width 2720
Set Height 1640
Set Padding 48
Set Margin 72
Set MarginFill "#c94a22"
Set WindowBar Colorful
Set WindowBarSize 80
Set BorderRadius 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# off camera: fetch the package once and tell npx not to ask about installing it
Hide
Type "export npm_config_yes=true npm_config_update_notifier=false && npx zerostel --version > /dev/null && rm -rf /tmp/zerostel-demo-* && clear"
Enter
Wait@120s
Show

Sleep 800ms
Type "npx zerostel demo"
Sleep 500ms
Enter
Wait+Screen@60s /report --open/
Sleep 8s

Type "cd /tmp/zerostel-demo-*/shop-api && clear"
Enter
Sleep 600ms
Type "ls -R src"
Sleep 300ms
Enter
Sleep 2s

Type "npx zerostel checks"
Sleep 300ms
Enter
Wait+Screen@30s /failing since/
Sleep 3500ms

Type "npx zerostel undo"
Sleep 300ms
Enter
Wait+Screen@30s /\[y\/N\]/
Sleep 3500ms
Type "y"
Sleep 400ms
Enter
Sleep 4s

Type "ls -R src"
Sleep 300ms
Enter
Sleep 6s
