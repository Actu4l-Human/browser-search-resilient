#!/bin/sh
set -eu

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_true "${CLOAK_ENABLED:-true}" && ! is_true "${CLOAK_HEADLESS:-true}"; then
  export DISPLAY="${DISPLAY:-:99}"
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  rm -f "/tmp/.X${display_number}-lock"
  Xvfb "${DISPLAY}" \
    -screen 0 "${XVFB_SCREEN:-1920x1080x24}" \
    -ac \
    -nolisten tcp \
    >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  trap 'kill "${xvfb_pid}" 2>/dev/null || true' EXIT INT TERM
  sleep 1
  if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
    cat /tmp/xvfb.log >&2 || true
    echo "Xvfb failed to start" >&2
    exit 1
  fi
fi

exec "$@"
