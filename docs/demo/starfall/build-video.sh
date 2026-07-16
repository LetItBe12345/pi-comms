#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO_DIR="$ROOT/docs/demo/starfall"
FRAME_DIR="${TMPDIR:-/tmp}/pi-comms-starfall-frames"
CHROME_BIN="${CHROME_BIN:-google-chrome}"
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

mkdir -p "$FRAME_DIR" "$DEMO_DIR/screenshots"

for state in 0 1 2 3 4 5 6; do
  "$CHROME_BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --run-all-compositor-stages-before-draw --virtual-time-budget=1200 \
    --user-data-dir="$FRAME_DIR/chrome-profile-$state-$$" \
    --window-size=1920,1080 --force-device-scale-factor=1 \
    --screenshot="$FRAME_DIR/state-$state.png" \
    "file://$DEMO_DIR/starfall-demo.html#$state"
done

cp "$FRAME_DIR/state-0.png" "$DEMO_DIR/cover.png"
cp "$FRAME_DIR/state-1.png" "$DEMO_DIR/screenshots/01-three-sessions-online.png"
cp "$FRAME_DIR/state-3.png" "$DEMO_DIR/screenshots/02-agent-handoff.png"
cp "$FRAME_DIR/state-6.png" "$DEMO_DIR/screenshots/03-rescue-window-open.png"

inputs=()
for state in 0 1 2 3 4 5 6; do
  inputs+=( -loop 1 -t 4 -i "$FRAME_DIR/state-$state.png" )
done

"$FFMPEG_BIN" -y "${inputs[@]}" -filter_complex \
  "[0:v]fps=30,format=yuv420p[v0];[1:v]fps=30,format=yuv420p[v1];[2:v]fps=30,format=yuv420p[v2];[3:v]fps=30,format=yuv420p[v3];[4:v]fps=30,format=yuv420p[v4];[5:v]fps=30,format=yuv420p[v5];[6:v]fps=30,format=yuv420p[v6];[v0][v1]xfade=transition=fade:duration=0.6:offset=3.4[x1];[x1][v2]xfade=transition=fade:duration=0.6:offset=6.8[x2];[x2][v3]xfade=transition=fade:duration=0.6:offset=10.2[x3];[x3][v4]xfade=transition=fade:duration=0.6:offset=13.6[x4];[x4][v5]xfade=transition=fade:duration=0.6:offset=17.0[x5];[x5][v6]xfade=transition=fade:duration=0.6:offset=20.4,fade=t=out:st=23.6:d=0.8,format=yuv420p[out]" \
  -map "[out]" -an -c:v libx264 -preset medium -crf 19 -movflags +faststart \
  "$DEMO_DIR/starfall-three-session-demo.mp4"

"$FFMPEG_BIN" -y -i "$DEMO_DIR/starfall-three-session-demo.mp4" -an \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 900k -row-mt 1 \
  "$DEMO_DIR/starfall-three-session-demo.webm"
