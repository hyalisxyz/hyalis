#!/usr/bin/env bash
# Builds the committed code (HEAD) on the VPS and restarts the app with it.
#
#   VPS_HOST=root@1.2.3.4 scripts/deploy-vps.sh
#
# Only committed files are sent (git archive), so local secrets and the local database never leave
# this machine. The server keeps its own /opt/agent-utility/.env and /opt/agent-utility/data.
# The previous image stays tagged by commit, so a rollback is: docker tag agent-utility:<old> agent-utility:latest
set -euo pipefail

HOST="${VPS_HOST:?set VPS_HOST, for example root@1.2.3.4}"
KEY="${VPS_KEY:-$HOME/.ssh/agent_utility_vps}"
DIR=/opt/agent-utility
REV="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes would not be deployed. Commit first." >&2
  exit 1
fi

ssh_vps() { ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }

echo "building $REV on $HOST"
git archive --format=tar HEAD | ssh_vps "set -e
  rm -rf $DIR/src.new && mkdir $DIR/src.new && tar -x -C $DIR/src.new
  cd $DIR/src.new && docker build -q -t agent-utility:$REV -t agent-utility:latest . >/dev/null
  rm -rf $DIR/src && mv $DIR/src.new $DIR/src
  cd $DIR && docker compose up -d --no-build 2>&1 | tail -1"

echo "waiting for the health check"
for _ in $(seq 1 30); do
  status="$(ssh_vps "docker inspect -f '{{.State.Health.Status}}' agent-utility")"
  [ "$status" = "healthy" ] && { echo "live: $REV"; exit 0; }
  sleep 5
done
echo "not healthy after 150s; recent log:" >&2
ssh_vps "docker logs --tail 30 agent-utility" >&2
exit 1
