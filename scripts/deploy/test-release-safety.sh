#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
apply="$deploy_dir/apply-release.sh"
hardening="$deploy_dir/jizhi-web-hardening.conf"
engine_hardening="$deploy_dir/jizhi-engine-hardening.conf"
base="$(mktemp -d /tmp/jizhi-release-safety.XXXXXX)"
real_pid=
cleanup() {
  [[ -z "$real_pid" ]] || { kill "$real_pid" 2>/dev/null || true; wait "$real_pid" 2>/dev/null || true; }
  rm -rf -- "$base"
}
trap cleanup EXIT
chmod 0755 "$base"

(( EUID == 0 )) || { echo "run this self-check as root" >&2; exit 2; }
bash -n "$apply"
while IFS= read -r shell_file; do
  ! LC_ALL=C grep -q $'\r' "$shell_file"
done < <(find "$deploy_dir" -maxdepth 1 -type f -name '*.sh' -print)
grep -Fqx 'EnvironmentFile=/etc/jizhi-web.env' "$hardening"
grep -Fqx 'WorkingDirectory=/opt/jizhi-web/current' "$hardening"
grep -Fqx 'ExecStart=/usr/bin/node /opt/jizhi-web/current/start-standalone.mjs' "$hardening"
! grep -Eq '/root/jizhi-agents|/srv/jizhi-repo' "$hardening"
grep -Fqx 'BindReadOnlyPaths=/var/lib/jizhi-web/usage:/srv/classroom/data/usage' "$engine_hardening"
! grep -Fq '/root/jizhi-agents' "$engine_hardening"

source <(awk '/^case "\${1:-}" in/{exit} {print}' "$apply")

unset root
[[ -z "$(resolve_current "$base/no-current-release")" ]]

token_is_safe '0123456789abcdef0123456789ABCDEF'
token_is_safe 'token_with-safe-chars_0123456789'
! token_is_safe 'short'
! token_is_safe '0123456789abcdef0123456789abc=+'
! token_is_safe 'demo-internal-token'

printf '%s\n' '{"success":true,"classrooms":[{"id":"public-course_1"}]}' >"$base/public-classrooms.json"
[[ "$(public_classroom_id "$base/public-classrooms.json")" == public-course_1 ]]
printf '%s\n' '{"success":true,"classrooms":[]}' >"$base/public-classrooms.json"
! public_classroom_id "$base/public-classrooms.json" >/dev/null 2>&1
printf '%s\n' '{"success":true,"classrooms":[{"id":"../escape"}]}' >"$base/public-classrooms.json"
! public_classroom_id "$base/public-classrooms.json" >/dev/null 2>&1

# Archive gate accepts only relative, in-release symlinks and regular payload types.
mkdir -p "$base/archive-src/dir"
printf payload >"$base/archive-src/dir/file"
printf '#!/bin/sh\nexit 0\n' >"$base/archive-src/dir/tool"
chmod 0755 "$base/archive-src/dir/tool"
ln -s file "$base/archive-src/dir/link"
tar -czf "$base/valid.tgz" -C "$base/archive-src" .
validate_archive "$base/valid.tgz"
mkdir -p "$base/bad-absolute" "$base/bad-escape" "$base/bad-hardlink"
ln -s /etc/passwd "$base/bad-absolute/link"
ln -s ../../outside "$base/bad-escape/link"
printf hardlink >"$base/bad-hardlink/file"
ln "$base/bad-hardlink/file" "$base/bad-hardlink/link"
tar -czf "$base/bad-absolute.tgz" -C "$base/bad-absolute" .
tar -czf "$base/bad-escape.tgz" -C "$base/bad-escape" .
tar -czf "$base/bad-hardlink.tgz" -C "$base/bad-hardlink" .
! validate_archive "$base/bad-absolute.tgz" >/dev/null 2>&1
! validate_archive "$base/bad-escape.tgz" >/dev/null 2>&1
! validate_archive "$base/bad-hardlink.tgz" >/dev/null 2>&1

mkdir -p "$base/release"
tar --no-same-owner --no-same-permissions -xzf "$base/valid.tgz" -C "$base/release"
printf '%s\n' fixture >"$base/release/.jizhi-release-id"
chown -hR root:root "$base/release"
chmod -R a+rX,go-w "$base/release"
validate_release_symlinks "$base/release"
validate_release_permissions "$base/release"
validate_release_access "$base/release" nobody
runuser -u nobody -- "$base/release/dir/tool"
verify_archive_payload "$base/valid.tgz" "$base/release" web
printf tamper >"$base/release/dir/file"
! verify_archive_payload "$base/valid.tgz" "$base/release" web >/dev/null 2>&1

# Tar files may omit parent directory entries; only parents implied by archived members are allowed.
tar -czf "$base/implicit-parent.tgz" -C "$base/archive-src" dir/file
mkdir "$base/implicit-parent-release"
tar -xzf "$base/implicit-parent.tgz" -C "$base/implicit-parent-release"
verify_archive_payload "$base/implicit-parent.tgz" "$base/implicit-parent-release" web
mkdir "$base/implicit-parent-release/unexpected"
! verify_archive_payload "$base/implicit-parent.tgz" "$base/implicit-parent-release" web >/dev/null 2>&1

# Engine verification must accept the installer-owned virtualenv root and its files.
mkdir -p "$base/engine-release/.venv/bin" "$base/engine-release/data"
tar -xzf "$base/valid.tgz" -C "$base/engine-release"
printf '%s\n' fixture >"$base/engine-release/.jizhi-release-id"
printf '%s\n' fixture >"$base/engine-release/installed-requirements.txt"
printf '%s\n' '#!/usr/bin/env python3' >"$base/engine-release/.venv/bin/python"
verify_archive_payload "$base/valid.tgz" "$base/engine-release" engine

# Staging is an exact, canonical, root-owned, non-writable set of regular files.
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
stage="$base/stage"
mkdir -m 0700 "$stage"
for name in SHA256SUMS "agent-engine-$sha.tgz" apply-release.sh \
  "classroom-next-$sha.tgz" jizhi-engine-hardening.conf jizhi-web-hardening.conf manifest.json; do
  printf fixture >"$stage/$name"
  chmod 0600 "$stage/$name"
done
(validate_staging "$stage" "$sha")
chmod 0660 "$stage/manifest.json"
! (validate_staging "$stage" "$sha") >/dev/null 2>&1
chmod 0600 "$stage/manifest.json"
mv "$stage/manifest.json" "$stage/manifest.real"
ln -s manifest.real "$stage/manifest.json"
! (validate_staging "$stage" "$sha") >/dev/null 2>&1
rm -f "$stage/manifest.json"
mv "$stage/manifest.real" "$stage/manifest.json"
chown 65534:65534 "$stage/manifest.json"
! (validate_staging "$stage" "$sha") >/dev/null 2>&1
chown root:root "$stage/manifest.json"

# Exercise the exact schema-4/hash preflight, then prove tampering is rejected.
cp "$apply" "$deploy_dir/jizhi-engine-hardening.conf" "$hardening" "$stage/"
mkdir -p "$base/web/.next" "$base/engine/app"
printf fixture-build-id >"$base/web/.next/BUILD_ID"
printf web >"$base/web/server.js"
printf engine >"$base/engine/app/main.py"
tar -czf "$stage/classroom-next-$sha.tgz" -C "$base/web" .
tar -czf "$stage/agent-engine-$sha.tgz" -C "$base/engine" .
python3 - "$stage" "$sha" <<'PY'
import hashlib
import json
import pathlib
import sys

stage = pathlib.Path(sys.argv[1])
sha = sys.argv[2]
names = sorted([
    f"agent-engine-{sha}.tgz",
    "apply-release.sh",
    f"classroom-next-{sha}.tgz",
    "jizhi-engine-hardening.conf",
    "jizhi-web-hardening.conf",
])
files = {name: hashlib.sha256((stage / name).read_bytes()).hexdigest() for name in names}
manifest = {
    "schemaVersion": 4,
    "webLayout": "next-standalone-v1",
    "gitSha": sha,
    "buildId": "fixture-build-id",
    "trackedDirty": False,
    "createdAt": "2026-09-01T00:00:00Z",
    "files": files,
}
(stage / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
with (stage / "SHA256SUMS").open("w", encoding="ascii") as handle:
    for name in sorted(names + ["manifest.json"]):
        digest = hashlib.sha256((stage / name).read_bytes()).hexdigest()
        handle.write(f"{digest}  {name}\n")
PY
chmod 0600 "$stage"/*
prefix="$(sha256sum "$stage/SHA256SUMS" | cut -c1-12)"
release_id="$sha-$prefix"
awk '/^validate_archive "\$web_archive"/{exit} {print}' "$apply" >"$base/preflight.sh"
bash "$base/preflight.sh" "$release_id" "$stage" >/dev/null
printf tamper >>"$stage/manifest.json"
! bash "$base/preflight.sh" "$release_id" "$stage" >/dev/null 2>&1

# Every declared fault point is injectable and returns the reserved failure status.
mapfile -t fault_points < <(sed -n 's/^[[:space:]]*fault_point \([A-Za-z0-9_-]*\)$/\1/p' "$apply" | sort -u)
[[ "${#fault_points[@]}" == 13 ]]
for point in "${fault_points[@]}"; do
  set +e
  (JIZHI_RELEASE_FAIL_AFTER="$point"; fault_point "$point") >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 97 ]]
done

# Reproduce each data-migration interruption with real moves/links, then restore it.
for stop_after in services-stopped-for-data-migration engine-data-move engine-data-link web-data-move web-data-link; do
  root="$base/migration-$stop_after"
  engine_source="$root/repo-engine"
  web_source="$root/repo-web"
  engine_destination="$root/var-engine"
  web_destination="$root/var-web"
  mkdir -p "$engine_source" "$web_source"
  printf engine >"$engine_source/sentinel"
  printf web >"$web_source/sentinel"
  engine_moved=0
  web_moved=0
  if [[ "$stop_after" != services-stopped-for-data-migration ]]; then
    engine_moved=1
    mv -T "$engine_source" "$engine_destination"
  fi
  if [[ "$stop_after" == engine-data-link || "$stop_after" == web-data-move || "$stop_after" == web-data-link ]]; then
    ln -s "$engine_destination" "$engine_source"
  fi
  if [[ "$stop_after" == web-data-move || "$stop_after" == web-data-link ]]; then
    web_moved=1
    mv -T "$web_source" "$web_destination"
  fi
  if [[ "$stop_after" == web-data-link ]]; then ln -s "$web_destination" "$web_source"; fi
  [[ "$web_moved" == 0 ]] || restore_moved_directory "$web_source" "$web_destination"
  [[ "$engine_moved" == 0 ]] || restore_moved_directory "$engine_source" "$engine_destination"
  [[ -f "$engine_source/sentinel" && ! -L "$engine_source" && ! -e "$engine_destination" ]]
  [[ -f "$web_source/sentinel" && ! -L "$web_source" && ! -e "$web_destination" ]]
done

# Release-link failures always restore the exact previous targets.
link_root="$base/link-rollback"
mkdir -p "$link_root/web/releases/old" "$link_root/web/releases/new" \
  "$link_root/engine/releases/old" "$link_root/engine/releases/new"
atomic_link "$link_root/web/releases/old" "$link_root/web/current"
atomic_link "$link_root/engine/releases/old" "$link_root/engine/current"
atomic_link "$link_root/engine/releases/new" "$link_root/engine/current"
atomic_link "$link_root/web/releases/new" "$link_root/web/current"
restore_current_link "$link_root/web" "$link_root/web/releases/old"
restore_current_link "$link_root/engine" "$link_root/engine/releases/old"
[[ "$(readlink -e "$link_root/web/current")" == "$link_root/web/releases/old" ]]
[[ "$(readlink -e "$link_root/engine/current")" == "$link_root/engine/releases/old" ]]

# Snapshot/restore covers both an existing secret file and an initially absent file.
rollback_dir="$base/snapshots"
mkdir "$rollback_dir"
printf before >"$base/existing.env"
snapshot "$base/existing.env" existing
snapshot "$base/absent.env" absent
printf after >"$base/existing.env"
printf created >"$base/absent.env"
restore_snapshot "$base/existing.env" existing
restore_snapshot "$base/absent.env" absent
[[ "$(cat "$base/existing.env")" == before && ! -e "$base/absent.env" ]]

# Generic legacy rows migrate to atomic markers; an injected post-migration fault restores rows and markers.
migration_web="$base/migration-web"
migration_data="$base/migration-engine-data"
migration_state="$base/migration-state"
fake_db="$base/fake-org-db.json"
mkdir -p "$migration_web/node_modules/pg" \
  "$migration_data/knowledge_base/corpora/fixture-one" \
  "$migration_data/knowledge_base/corpora/fixture-two" \
  "$migration_data/knowledge_base/corpora/fixture-new" "$migration_state"
cat >"$migration_web/node_modules/pg/index.js" <<'JS'
const fs = require("node:fs");
const statePath = process.env.JIZHI_FAKE_PG_STATE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
class Client {
  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    const state = load();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [], rowCount: 0 };
    if (text === "LOCK TABLE org_corpora IN EXCLUSIVE MODE") return { rows: [], rowCount: 0 };
    if (text.includes("FROM org_corpora c LEFT JOIN orgs")) {
      return { rows: state.rows.map((row) => ({ ...row, org_exists: state.orgs.includes(row.org_id) })), rowCount: state.rows.length };
    }
    if (text.startsWith("DELETE FROM org_corpora")) {
      const before = state.rows.length;
      state.rows = state.rows.filter((row) => row.corpus !== params[0] || row.org_id !== params[1]);
      save(state);
      return { rows: [], rowCount: before - state.rows.length };
    }
    if (text.startsWith("SELECT COUNT(*)::int")) return { rows: [{ count: state.rows.length }], rowCount: 1 };
    if (text.startsWith("SELECT 1 FROM orgs")) return { rows: state.orgs.includes(params[0]) ? [{ "?column?": 1 }] : [], rowCount: state.orgs.includes(params[0]) ? 1 : 0 };
    if (text.startsWith("SELECT corpus, org_id FROM org_corpora")) {
      return { rows: [...state.rows].sort((left, right) => left.corpus.localeCompare(right.corpus)), rowCount: state.rows.length };
    }
    if (text.startsWith("INSERT INTO org_corpora")) {
      state.rows.push({ corpus: params[0], org_id: params[1] });
      save(state);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release() {}
}
class Pool {
  async connect() { return new Client(); }
  async end() {}
}
module.exports = { Pool };
JS
printf '%s\n' '{"orgs":["org-fixture-a","org-fixture-b","org-fixture-c"],"rows":[{"corpus":"fixture-one","org_id":"org-fixture-a"},{"corpus":"fixture-two","org_id":"org-fixture-b"}]}' >"$fake_db"
printf '%s\n' 'PERSISTENCE_DATABASE_URL=postgres://fixture:fixture-secret@invalid/jizhi' >"$base/protected-web.env"
chmod 0640 "$base/protected-web.env"
printf '%s\n' org-fixture-a >"$migration_data/knowledge_base/corpora/fixture-one/.jizhi-owner-org"
printf '%s\n' wrong-org >"$migration_data/knowledge_base/corpora/fixture-two/.jizhi-owner-org"
export JIZHI_FAKE_PG_STATE="$fake_db"
set +e
migration_output="$(run_corpus_ownership_migration migrate "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state" 2>&1)"
migration_status=$?
set -e
[[ "$migration_status" != 0 && "$migration_output" != *fixture-secret* ]]
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 2 ]]
rm "$migration_data/knowledge_base/corpora/fixture-two/.jizhi-owner-org"
run_corpus_ownership_migration migrate "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state"
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 0 ]]
[[ "$(cat "$migration_data/knowledge_base/corpora/fixture-two/.jizhi-owner-org")" == org-fixture-b ]]
[[ "$(stat -c %a "$migration_state/legacy-org-corpora.json")" == 600 ]]
set +e
(JIZHI_RELEASE_FAIL_AFTER=corpus-ownership-migrated; fault_point corpus-ownership-migrated) >/dev/null 2>&1
migration_fault_status=$?
set -e
[[ "$migration_fault_status" == 97 ]]

# A private corpus created while first-migration rollback is retained must be restored to the legacy table.
printf '%s\n%s\n' org-fixture-c damaged >"$migration_data/knowledge_base/corpora/fixture-new/.jizhi-owner-org"
! run_corpus_ownership_migration rollback "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state" >/dev/null 2>&1
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 0 ]]
printf '%s\n' org-unknown >"$migration_data/knowledge_base/corpora/fixture-new/.jizhi-owner-org"
! run_corpus_ownership_migration rollback "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state" >/dev/null 2>&1
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 0 ]]
printf '%s\n' org-fixture-b >"$migration_data/knowledge_base/corpora/fixture-one/.jizhi-owner-org"
! run_corpus_ownership_migration rollback "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state" >/dev/null 2>&1
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 0 ]]
printf '%s\n' org-fixture-a >"$migration_data/knowledge_base/corpora/fixture-one/.jizhi-owner-org"
printf '%s\n' org-fixture-c >"$migration_data/knowledge_base/corpora/fixture-new/.jizhi-owner-org"
rollback_legacy_corpus_ownership "$migration_web" "$base/protected-web.env" "$migration_data" "$migration_state"
[[ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$fake_db")" == 3 ]]
[[ "$(python3 -c 'import json,sys; rows=json.load(open(sys.argv[1]))["rows"]; print(next(row["org_id"] for row in rows if row["corpus"] == "fixture-new"))' "$fake_db")" == org-fixture-c ]]
[[ "$(cat "$migration_data/knowledge_base/corpora/fixture-one/.jizhi-owner-org")" == org-fixture-a ]]
[[ ! -e "$migration_data/knowledge_base/corpora/fixture-two/.jizhi-owner-org" ]]
[[ "$(cat "$migration_data/knowledge_base/corpora/fixture-new/.jizhi-owner-org")" == org-fixture-c ]]
unset JIZHI_FAKE_PG_STATE

# Acceptance removes only a complete, root-only retained first-migration state.
first_migration_state="$base/first-migration-rollback"
mkdir -m 0700 "$first_migration_state"
printf 'schema=1\nrelease_id=fixture\n' >"$first_migration_state/state"
cp "$apply" "$first_migration_state/apply-release.sh"
chmod 0700 "$first_migration_state/apply-release.sh"
for name in engine.env web.env engine.dropin web.dropin; do : >"$first_migration_state/$name.absent"; done
for name in legacy-org-corpora.json created-owner-markers.json; do
  printf '%s\n' '[]' >"$first_migration_state/$name"
  chmod 0600 "$first_migration_state/$name"
done
validate_first_migration_state
accept_first_migration >/dev/null
[[ ! -e "$first_migration_state" ]]

# Retention keeps current + exactly two managed predecessors and never touches unknown dirs.
retention="$base/retention"
mkdir -p "$retention/releases/legacy-manual"
ids=()
for digit in 1 2 3 4 5; do
  id="$(printf '%040d' "$digit")-$(printf '%012d' "$digit")"
  ids+=("$id")
  mkdir "$retention/releases/$id"
  printf '%s\n' "$id" >"$retention/releases/$id/.jizhi-release-id"
  touch -d "2026-01-0${digit} 00:00:00 UTC" "$retention/releases/$id"
done
atomic_link "$retention/releases/${ids[4]}" "$retention/current"
prune_releases "$retention" 2
[[ -d "$retention/releases/${ids[4]}" && -d "$retention/releases/${ids[3]}" && -d "$retention/releases/${ids[2]}" ]]
[[ ! -e "$retention/releases/${ids[0]}" && ! -e "$retention/releases/${ids[1]}" ]]
[[ -d "$retention/releases/legacy-manual" ]]

require_space "$base" 1 fixture
! (require_space "$base" 999999999999999 fixture) >/dev/null 2>&1
probe_line="$(grep -n '^probe_internal_auth$' "$apply" | cut -d: -f1)"
trap_clear_line="$(grep -n '^trap - ERR HUP INT TERM$' "$apply" | tail -n 1 | cut -d: -f1)"
[[ "$probe_line" -lt "$trap_clear_line" ]]
grep -Fq "body.get(\"engineBridge\") != \"ok\"" "$apply"
grep -Fq "[[ \"\$negative_status\" == 401 ]]" "$apply"
grep -Fq "PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -c 'from app.main import app; assert app'" "$apply"
grep -Fq 'set_env /etc/jizhi-web.env ACCOUNTS_DIR /var/lib/jizhi-web/accounts' "$apply"
grep -Fq "! grep -Fq '/root/jizhi-agents' /etc/jizhi-web.env" "$apply"
grep -Fq 'node --check "$web_incoming/server.js"' "$apply"
grep -Fq 'chmod -R a+rX,go-w "$web_incoming" "$engine_incoming"' "$apply"
grep -Fq 'chmod 0600 "$repo/apps/agent-engine/.env" "$repo/apps/classroom/.env.local"' "$apply"
grep -Fq 'JIZHI_PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple' "$apply"
grep -Fq -- '--require-hashes -r "$engine_incoming/requirements.production.lock"' "$apply"
grep -Fq -- '--accept-first-migration' "$apply"
grep -Fq -- '--rollback-first-migration' "$apply"
grep -Fq 'restore_moved_directory "$repo/apps/classroom/data" /var/lib/jizhi-web' "$apply"
grep -Fq 'restore_moved_directory "$repo/apps/agent-engine/data" /var/lib/jizhi-engine' "$apply"
grep -Fq 'fault_point corpus-ownership-migrated' "$apply"
grep -Fq 'run_corpus_ownership_migration migrate "$web_release" /etc/jizhi-web.env /var/lib/jizhi-engine "$rollback_dir"' "$apply"
engine_flag_line="$(grep -n '^[[:space:]]*engine_data_moved=1$' "$apply" | cut -d: -f1)"
engine_move_line="$(grep -n 'mv -T "$repo/apps/agent-engine/data" /var/lib/jizhi-engine' "$apply" | cut -d: -f1)"
web_flag_line="$(grep -n '^[[:space:]]*web_data_moved=1$' "$apply" | cut -d: -f1)"
web_move_line="$(grep -n 'mv -T "$repo/apps/classroom/data" /var/lib/jizhi-web' "$apply" | cut -d: -f1)"
[[ "$engine_flag_line" -lt "$engine_move_line" && "$web_flag_line" -lt "$web_move_line" ]]

# A release cannot pass without exercising the real Windows-built standalone as a non-root user.
(( $# == 1 )) || die "usage: $0 classroom-standalone.tgz"
real_archive="$1"
[[ -f "$real_archive" ]] || die "standalone archive not found: $real_archive"
validate_archive "$real_archive"
real_release="$base/real-standalone"
mkdir "$real_release"
tar --no-same-owner --no-same-permissions -xzf "$real_archive" -C "$real_release"
chown -hR root:root "$real_release"
chmod -R a+rX,go-w "$real_release"
validate_release_symlinks "$real_release"
validate_release_permissions "$real_release"
validate_release_access "$real_release" nobody
verify_archive_payload "$real_archive" "$real_release" web
[[ -f "$real_release/server.js" ]]
[[ -f "$real_release/start-standalone.mjs" ]]
[[ -s "$real_release/.next/BUILD_ID" ]]
[[ -d "$real_release/.next/static" && -d "$real_release/public" ]]
[[ -d "$real_release/data" && -d "$real_release/.next/cache" ]]
[[ -z "$(find "$real_release/data" "$real_release/.next/cache" -mindepth 1 -print -quit)" ]]
grep -Fq 'await import("./server.js")' "$real_release/start-standalone.mjs" ||
  grep -Fq "await import('./server.js')" "$real_release/start-standalone.mjs"
find "$real_release/node_modules/.pnpm" -type f -name 'sharp-linux-x64.node' -print -quit | grep -q .
find "$real_release/node_modules/.pnpm" -type f -name 'libvips-cpp.so.*' -print -quit | grep -q .
! find "$real_release" -type l -printf '%l\n' | grep -Eq '(^|/)(root/jizhi-agents|srv/jizhi-repo)|^[A-Za-z]:[/\\]'
runuser -u nobody -- bash -c 'cd "$1" && node -e '\''require("sharp")({create:{width:1,height:1,channels:4,background:"#fff"}}).png().toBuffer()'\''' _ "$real_release"

nobody_group="$(id -gn nobody)"
chown nobody:"$nobody_group" "$real_release/data" "$real_release/.next/cache"
chmod 0750 "$real_release/data" "$real_release/.next/cache"
port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)"
(
  cd "$real_release"
  exec runuser -u nobody -- env HOSTNAME=127.0.0.1 PORT="$port" NODE_ENV=production \
    node ./start-standalone.mjs
) >"$base/standalone.log" 2>&1 &
real_pid=$!
ready=0
for _ in {1..30}; do
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/" >/dev/null; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat "$base/standalone.log" >&2
  die "non-root standalone did not answer HTTP"
fi
kill "$real_pid"
wait "$real_pid" || true
real_pid=

echo "release safety self-check: ok"
