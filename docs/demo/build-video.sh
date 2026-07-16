#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO_DIR="$ROOT/docs/demo"
FRAME_DIR="${TMPDIR:-/tmp}/pi-comms-demo-frames"
CHROME_BIN="${CHROME_BIN:-google-chrome}"
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

mkdir -p "$FRAME_DIR"
for state in 0 1 2 3 4 5 6 7; do
  "$CHROME_BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size=1920,1080 --force-device-scale-factor=1 \
    --screenshot="$FRAME_DIR/state-$state.png" \
    "file://$DEMO_DIR/three-session-demo.html#$state"
done

cp "$FRAME_DIR/state-0.png" "$DEMO_DIR/cover.png"

inputs=()
for state in 0 1 2 3 4 5 6 7; do
  inputs+=( -loop 1 -t 4 -i "$FRAME_DIR/state-$state.png" )
done

"$FFMPEG_BIN" -y "${inputs[@]}" -filter_complex \
  "[0:v]fps=30,format=yuv420p[v0];[1:v]fps=30,format=yuv420p[v1];[2:v]fps=30,format=yuv420p[v2];[3:v]fps=30,format=yuv420p[v3];[4:v]fps=30,format=yuv420p[v4];[5:v]fps=30,format=yuv420p[v5];[6:v]fps=30,format=yuv420p[v6];[7:v]fps=30,format=yuv420p[v7];[v0][v1]xfade=transition=fade:duration=0.6:offset=3.4[x1];[x1][v2]xfade=transition=fade:duration=0.6:offset=6.8[x2];[x2][v3]xfade=transition=fade:duration=0.6:offset=10.2[x3];[x3][v4]xfade=transition=fade:duration=0.6:offset=13.6[x4];[x4][v5]xfade=transition=fade:duration=0.6:offset=17.0[x5];[x5][v6]xfade=transition=fade:duration=0.6:offset=20.4[x6];[x6][v7]xfade=transition=fade:duration=0.6:offset=23.8,fade=t=out:st=27.0:d=0.8,format=yuv420p[out]" \
  -map "[out]" -an -c:v libx264 -preset medium -crf 20 -movflags +faststart \
  "$DEMO_DIR/pi-comms-three-session-demo.mp4"

"$FFMPEG_BIN" -y -i "$DEMO_DIR/pi-comms-three-session-demo.mp4" -an \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 \
  "$DEMO_DIR/pi-comms-three-session-demo.webm"
