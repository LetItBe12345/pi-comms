#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO_DIR="$ROOT/docs/demo/release-fleet"
FRAME_DIR="${TMPDIR:-/tmp}/pi-release-fleet-frames"
CHROME_BIN="${CHROME_BIN:-google-chrome}"
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

rm -rf "$FRAME_DIR"
mkdir -p "$FRAME_DIR" "$DEMO_DIR/screenshots"

for state in $(seq 0 11); do
  "$CHROME_BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --run-all-compositor-stages-before-draw --virtual-time-budget=1200 \
    --user-data-dir="$FRAME_DIR/chrome-profile-$state-$$" \
    --window-size=1920,1080 --force-device-scale-factor=1 \
    --screenshot="$FRAME_DIR/state-$state.png" \
    "file://$DEMO_DIR/release-fleet-demo.html#$state"
done

cp "$FRAME_DIR/state-0.png" "$DEMO_DIR/cover.png"
cp "$FRAME_DIR/state-3.png" "$DEMO_DIR/screenshots/01-release-published.png"
cp "$FRAME_DIR/state-6.png" "$DEMO_DIR/screenshots/02-three-platform-testing.png"
cp "$FRAME_DIR/state-7.png" "$DEMO_DIR/screenshots/03-macos-failure-returned.png"
cp "$FRAME_DIR/state-11.png" "$DEMO_DIR/screenshots/04-release-verified.png"

inputs=()
durations=(4 5 6 5 6 6 7 7 7 7 7 7)
for state in $(seq 0 11); do
  inputs+=( -loop 1 -t "${durations[$state]}" -i "$FRAME_DIR/state-$state.png" )
done

"$FFMPEG_BIN" -y "${inputs[@]}" -filter_complex \
  "[0:v]fps=30,format=yuv420p[v0];[1:v]fps=30,format=yuv420p[v1];[2:v]fps=30,format=yuv420p[v2];[3:v]fps=30,format=yuv420p[v3];[4:v]fps=30,format=yuv420p[v4];[5:v]fps=30,format=yuv420p[v5];[6:v]fps=30,format=yuv420p[v6];[7:v]fps=30,format=yuv420p[v7];[8:v]fps=30,format=yuv420p[v8];[9:v]fps=30,format=yuv420p[v9];[10:v]fps=30,format=yuv420p[v10];[11:v]fps=30,format=yuv420p[v11];[v0][v1]xfade=transition=fade:duration=0.55:offset=3.45[x1];[x1][v2]xfade=transition=fade:duration=0.55:offset=7.90[x2];[x2][v3]xfade=transition=fade:duration=0.55:offset=13.35[x3];[x3][v4]xfade=transition=fade:duration=0.55:offset=17.80[x4];[x4][v5]xfade=transition=fade:duration=0.55:offset=23.25[x5];[x5][v6]xfade=transition=fade:duration=0.55:offset=28.70[x6];[x6][v7]xfade=transition=fade:duration=0.55:offset=35.15[x7];[x7][v8]xfade=transition=fade:duration=0.55:offset=41.60[x8];[x8][v9]xfade=transition=fade:duration=0.55:offset=48.05[x9];[x9][v10]xfade=transition=fade:duration=0.55:offset=54.50[x10];[x10][v11]xfade=transition=fade:duration=0.55:offset=60.95,fade=t=out:st=67.0:d=0.9,format=yuv420p[out]" \
  -map "[out]" -an -c:v libx264 -preset medium -crf 19 -movflags +faststart \
  "$DEMO_DIR/release-fleet-workflow-demo.mp4"
