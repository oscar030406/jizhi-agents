#!/usr/bin/env bash
set -Eeuo pipefail

sha="${1:?usage: apply-release.sh <12-char-sha> <staging-dir>}"
staging="${2:?usage: apply-release.sh <12-char-sha> <staging-dir>}"
[[ "$sha" =~ ^[0-9a-f]{12}$ ]] || { echo "invalid release sha" >&2; exit 2; }
cd "$staging"
sha256sum -c SHA256SUMS

web_archive="classroom-next-$sha.tgz"
engine_archive="agent-engine-$sha.tgz"
web_root=/opt/jizhi-web
engine_root=/opt/jizhi-engine
repo=/root/jizhi-agents
web_release="$web_root/releases/$sha"
engine_release="$engine_root/releases/$sha"

install -d -m 0755 "$web_release" "$engine_release" /srv/jizhi-repo /srv/jizhi-engine \
  /srv/classroom/data/usage
tar -xzf "$web_archive" -C "$web_release"
tar -xzf "$engine_archive" -C "$engine_release"
install -d -m 0755 "$web_release/.next/cache" "$engine_release/.venv" "$engine_release/data"

id -u jizhi-engine >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin jizhi-engine
id -u jizhi-web >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin jizhi-web

old_web="$(readlink -e "$web_root/current" 2>/dev/null || true)"
old_engine="$(readlink -e "$engine_root/current" 2>/dev/null || true)"
legacy="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="$(mktemp -d /var/tmp/jizhi-release-rollback.XXXXXX)"
first_migration=0
legacy_web_release=
legacy_engine_release=
engine_venv_moved=0
engine_data_moved=0
web_next_moved=0

atomic_link() {
  local target="$1" link="$2"
  ln -sfn "$target" "$link.next"
  mv -Tf "$link.next" "$link"
}

set_env() {
  local file="$1" key="$2" value="$3" group="$4" mode="$5" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -f "$file" ]]; then grep -v "^${key}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  install -o root -g "$group" -m "$mode" "$tmp" "$file"
  rm -f "$tmp"
}

wait_http() {
  local url="$1"
  for _ in {1..30}; do curl -fsS "$url" >/dev/null && return 0; sleep 2; done
  return 1
}

fault_point() {
  [[ "${JIZHI_RELEASE_FAIL_AFTER:-}" != "$1" ]] || {
    echo "injected release failure after $1" >&2
    return 97
  }
}

snapshot() {
  local path="$1" name="$2"
  if [[ -e "$path" ]]; then cp -a "$path" "$rollback_dir/$name"
  else : >"$rollback_dir/$name.absent"
  fi
}

restore_snapshot() {
  local path="$1" name="$2"
  if [[ -f "$rollback_dir/$name.absent" ]]; then rm -f "$path"
  else cp -a "$rollback_dir/$name" "$path"
  fi
}

rollback_first_migration() {
  local failed=0 paths_restored=1
  systemctl stop jizhi-engine.service jizhi-web.service || failed=1

  rm -f -- "$web_root/current" "$web_root/current.next" || failed=1
  if [[ "$web_next_moved" == 1 ]]; then
    rm -f -- "$repo/apps/classroom/.next" || failed=1
    mv "$legacy_web_release/.next" "$repo/apps/classroom/.next" || { failed=1; paths_restored=0; }
  fi

  rm -f -- "$engine_root/current" "$engine_root/current.next" || failed=1
  if [[ "$engine_data_moved" == 1 ]]; then
    rm -f -- "$repo/apps/agent-engine/data" || failed=1
    mv /var/lib/jizhi-engine "$repo/apps/agent-engine/data" || { failed=1; paths_restored=0; }
  fi
  if [[ "$engine_venv_moved" == 1 ]]; then
    rm -f -- "$repo/apps/agent-engine/.venv" || failed=1
    mv "$engine_root/venv" "$repo/apps/agent-engine/.venv" || { failed=1; paths_restored=0; }
  fi

  if [[ "$paths_restored" == 1 ]]; then
    [[ -z "$legacy_web_release" ]] || rm -rf -- "$legacy_web_release" || failed=1
    [[ -z "$legacy_engine_release" ]] || rm -rf -- "$legacy_engine_release" || failed=1
  fi
  return "$failed"
}

snapshot /etc/jizhi-engine.env engine.env
snapshot "$repo/apps/classroom/.env.local" web.env
snapshot /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf engine.dropin
snapshot /etc/systemd/system/jizhi-web.service.d/90-hardening.conf web.dropin

rollback() {
  local cause=$?
  trap - ERR
  set +e
  local failed=0
  if [[ "$first_migration" == 1 ]]; then
    rollback_first_migration || failed=1
  else
    [[ -n "$old_web" && -d "$old_web" ]] && atomic_link "$old_web" "$web_root/current"
    [[ -n "$old_engine" && -d "$old_engine" ]] && atomic_link "$old_engine" "$engine_root/current"
  fi
  restore_snapshot /etc/jizhi-engine.env engine.env || failed=1
  restore_snapshot "$repo/apps/classroom/.env.local" web.env || failed=1
  restore_snapshot /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf engine.dropin || failed=1
  restore_snapshot /etc/systemd/system/jizhi-web.service.d/90-hardening.conf web.dropin || failed=1
  systemctl daemon-reload || failed=1
  systemctl restart jizhi-engine.service jizhi-web.service || failed=1
  wait_http http://127.0.0.1:8001/health || failed=1
  wait_http http://127.0.0.1:3210/ || failed=1
  if [[ "$failed" == 0 ]]; then
    echo "release failed; previous release restored and healthy" >&2
  else
    echo "release and rollback both failed; services need intervention" >&2
  fi
  rm -rf -- "$rollback_dir"
  [[ "$failed" == 0 ]] && exit "$cause"
  exit 1
}
trap rollback ERR

# First release: separate immutable code from the existing venv and business data.
if [[ -z "$old_engine" ]]; then
  first_migration=1
  systemctl stop jizhi-engine.service jizhi-web.service

  legacy_engine_release="$engine_root/releases/$legacy"
  install -d -m 0755 "$legacy_engine_release"
  cp -a "$repo/apps/agent-engine/app" "$repo/apps/agent-engine/backend" \
    "$repo/apps/agent-engine/scripts" "$repo/apps/agent-engine/requirements.txt" "$legacy_engine_release/"
  install -d -m 0755 "$legacy_engine_release/.venv" "$legacy_engine_release/data"
  fault_point legacy-engine-copy

  mv "$repo/apps/agent-engine/.venv" "$engine_root/venv"
  engine_venv_moved=1
  fault_point engine-venv-move
  ln -s "$engine_root/venv" "$repo/apps/agent-engine/.venv"
  fault_point engine-venv-link
  mv "$repo/apps/agent-engine/data" /var/lib/jizhi-engine
  engine_data_moved=1
  fault_point engine-data-move
  ln -s /var/lib/jizhi-engine "$repo/apps/agent-engine/data"
  fault_point engine-data-link
  atomic_link "$legacy_engine_release" "$engine_root/current"
  fault_point engine-legacy-link

  legacy_web_release="$web_root/releases/$legacy"
  install -d -m 0755 "$legacy_web_release"
  fault_point legacy-web-create
  mv "$repo/apps/classroom/.next" "$legacy_web_release/.next"
  web_next_moved=1
  fault_point web-next-move
  atomic_link "$legacy_web_release" "$web_root/current"
  fault_point web-legacy-link
  ln -s "$web_root/current/.next" "$repo/apps/classroom/.next"
  fault_point web-next-link
fi

install -d -o jizhi-web -g jizhi-web -m 0750 /var/cache/jizhi-web
chown -R jizhi-web:jizhi-web "$repo/apps/classroom/data" /var/cache/jizhi-web
chown -R jizhi-engine:jizhi-engine /var/lib/jizhi-engine

if [[ ! -f /etc/jizhi-engine.env ]]; then
  install -o root -g root -m 0600 "$repo/apps/agent-engine/.env" /etc/jizhi-engine.env
fi
token="$(sed -n 's/^AI_SERVICE_TOKEN=//p' /etc/jizhi-engine.env | tail -n 1)"
if [[ ${#token} -lt 32 || "$token" == "demo-internal-token" ]]; then
  token="$(openssl rand -hex 32)"
fi
set_env /etc/jizhi-engine.env AI_SERVICE_TOKEN "$token" root 0600
set_env /etc/jizhi-engine.env CLASSROOM_BASE_URL http://127.0.0.1:3210 root 0600
set_env "$repo/apps/classroom/.env.local" GROUNDING_TOKEN "$token" jizhi-web 0640

install -d -m 0755 /etc/systemd/system/jizhi-engine.service.d /etc/systemd/system/jizhi-web.service.d
install -o root -g root -m 0644 jizhi-engine-hardening.conf /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf
install -o root -g root -m 0644 jizhi-web-hardening.conf /etc/systemd/system/jizhi-web.service.d/90-hardening.conf

atomic_link "$engine_release" "$engine_root/current"
fault_point engine-release-link
atomic_link "$web_release" "$web_root/current"
fault_point web-release-link
systemctl daemon-reload
systemctl restart jizhi-engine.service jizhi-web.service

wait_http http://127.0.0.1:8001/health
wait_http http://127.0.0.1:3210/
wait_http http://127.0.0.1:3210/api/auth
wait_http http://127.0.0.1:3210/admin/org

assert_service_user() {
  local service="$1" user="$2" pid actual expected
  systemctl is-active --quiet "$service"
  pid="$(systemctl show -p MainPID --value "$service")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
  actual="$(ps -o uid= -p "$pid" | tr -d ' ')"
  expected="$(id -u "$user")"
  [[ "$actual" == "$expected" ]]
}
assert_service_user jizhi-engine.service jizhi-engine
assert_service_user jizhi-web.service jizhi-web

trap - ERR
rm -rf -- "$rollback_dir"
echo "release=$sha web=ok engine=ok users=nonroot"
