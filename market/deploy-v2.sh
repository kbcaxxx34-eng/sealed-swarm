#!/usr/bin/env bash
# Upgrades the SealedSwarm live market on this server to v2. Touches only the SealedSwarm market:
# its repository checkout, its env file (adds NEARAI_API_KEY if you type one) and its systemd
# service. Nothing else on the server is changed. Every step prints what it does; it stops on the
# first error. Run as root:  bash deploy-v2.sh
set -euo pipefail
BRANCH="${BRANCH:-judge-ready}"
LOG=/root/sealedswarm-deploy.log
# Asks for the NEAR AI key once (hidden), then continues in the background so the terminal can be
# closed (e.g. a phone). Follow it with: tail -f /root/sealedswarm-deploy.log
if [ -z "${DETACHED:-}" ]; then
  read -r -s -p "NEAR AI Cloud key (sk-...; hidden; Enter to skip): " K; echo
  DETACHED=1 NEARAI_KEY_INPUT="$K" BRANCH="$BRANCH" nohup bash "$0" > "$LOG" 2>&1 < /dev/null &
  unset K
  echo "Running in the background — you can close this terminal. Log: $LOG"
  sleep 20; tail -n 25 "$LOG"; exit 0
fi
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*"; exit 1; }

say "1/9 Finding the market service"
UNIT=$(systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -i -E 'sealed.?swarm|ssmarket' | head -1 || true)
[ -n "$UNIT" ] || die "no SealedSwarm market service found (systemctl list-unit-files | grep -i swarm)"
WD=$(systemctl show -p WorkingDirectory --value "$UNIT")
RUNAS=$(systemctl show -p User --value "$UNIT"); RUNAS=${RUNAS:-root}
ENVF=$(systemctl cat "$UNIT" | sed -n 's/^EnvironmentFile=-\{0,1\}//p' | head -1)
[ -d "$WD" ] && [ -f "$WD/bot.mjs" ] || die "working directory $WD has no bot.mjs"
REPO=$(cd "$WD" && git rev-parse --show-toplevel)
echo "service:  $UNIT (runs as $RUNAS)"
echo "repo:     $REPO (now at $(git -C "$REPO" rev-parse --short HEAD), branch $(git -C "$REPO" rev-parse --abbrev-ref HEAD))"
echo "env file: ${ENVF:-none}"
[ -n "$ENVF" ] && [ -f "$ENVF" ] || die "the service has no EnvironmentFile"
set -a; . "$ENVF"; set +a
STATE="${STATE_FILE:-$WD/state.json}"; MJSON="${MARKET_JSON:-$WD/market.json}"
[ -f "$STATE" ] || die "state file $STATE not found"
echo "state:    $STATE"
echo "market:   $MJSON"
echo "env vars: $(grep -o '^[A-Z_]*=' "$ENVF" | tr -d '=' | tr '\n' ' ')(values not shown)"
[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] && die "the repository has local changes; not touching it (git -C $REPO status)"

say "2/9 Backup (state, market data, env, current commit) — nothing is deleted"
BK="/root/sealedswarm-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"; chmod 700 "$BK"
cp -a "$STATE" "$BK/"; cp -a "$MJSON" "$BK/" 2>/dev/null || true; cp -a "$ENVF" "$BK/"
git -C "$REPO" rev-parse HEAD > "$BK/commit.txt"
echo "saved in $BK  (to roll back: see the end of this script's output)"

say "3/9 Waiting until no round is in progress (a round takes ~15 minutes)"
for i in $(seq 1 60); do
  last=$(journalctl -u "$UNIT" -n 300 -o cat --no-pager | grep -E 'auction #[0-9]+: ' | tail -1 || true)
  if [ -z "$last" ] || echo "$last" | grep -q ' pays '; then echo "idle (last: ${last:-none})"; break; fi
  echo "round in progress: $last — checking again in 60 s"; sleep 60
done

say "4/9 Getting the new code ($BRANCH)"
git -C "$REPO" fetch -q origin "$BRANCH"
git -C "$REPO" checkout -q -B "$BRANCH" "origin/$BRANCH"
echo "now at $(git -C "$REPO" rev-parse --short HEAD)"
(cd "$WD" && npm ci --no-audit --no-fund --omit=dev >/dev/null) && echo "market dependencies installed"

say "5/9 NEAR AI Cloud key (agents reason in a TEE)"
if grep -q '^NEARAI_API_KEY=.' "$ENVF"; then echo "already set in $ENVF"; else
  K="${NEARAI_KEY_INPUT:-}"
  if [ -n "$K" ]; then printf 'NEARAI_API_KEY=%s\n' "$K" >> "$ENVF"; export NEARAI_API_KEY="$K"; echo "added to $ENVF"; else echo "skipped: agents stay rule-based"; fi
  unset K NEARAI_KEY_INPUT
fi

say "6/9 Stopping only the market service"
systemctl stop "$UNIT"; echo "$UNIT stopped"
# the env file was loaded (set -a) above as root; pass it on to the service user unchanged
run() { if [ "$RUNAS" = root ]; then node "$WD/bot.mjs" "$@"; else sudo --preserve-env -u "$RUNAS" node "$WD/bot.mjs" "$@"; fi; }
cd "$WD"
if grep -q '^NEARAI_API_KEY=.' "$ENVF"; then run selftest-ai || echo "(NEAR AI self-test failed: the bot will fall back to rules; check the key)"; fi

say "7/9 Creating the v2 vaults, second owner, NEAR seller and wNEAR float (testnet only)"
if ! run upgrade; then
  systemctl start "$UNIT"
  die "upgrade stopped (usually: not enough testnet NEAR). The old market was restarted unchanged. Get free testnet NEAR for $NEAR_OWNER at https://docs.near.org/getting-started/faucet and run this script again."
fi

say "8/9 Publishing the new dashboard next to market.json"
DASH=$(dirname "$MJSON")
if [ "$DASH" != "$WD" ]; then cp "$WD/dashboard.html" "$WD/verify-browser.js" "$DASH/"; fi
[ -f "$DASH/index.html" ] && ! cmp -s "$DASH/index.html" "$WD/dashboard.html" && cp "$DASH/index.html" "$BK/index.html.old" && cp "$WD/dashboard.html" "$DASH/index.html" || true
ls -la "$DASH" | grep -E 'dashboard|index|verify-browser|market.json' || true

say "9/9 One test round in the foreground (~15 min), then the service starts again"
if run round; then echo "test round OK"; else echo "test round FAILED — starting the service anyway; send the output above to Claude"; fi
systemctl start "$UNIT"; sleep 3; systemctl --no-pager --lines=5 status "$UNIT" || true
cat <<EOF

Done. Live: https://sealedbid.lercomigo.space/swarm/market/
Roll back if needed:
  systemctl stop $UNIT && git -C $REPO checkout -q \$(cat $BK/commit.txt) && cp -a $BK/$(basename "$STATE") $STATE && cp -a $BK/$(basename "$MJSON") $MJSON && cp -a $BK/$(basename "$ENVF") $ENVF && systemctl start $UNIT
EOF
