#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
first_migration_state=/var/lib/jizhi-release/first-migration-rollback

die() {
  echo "$*" >&2
  exit 2
}

token_is_safe() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{32,128}$ && "$1" != "demo-internal-token" ]]
}

validate_staging() {
  local stage="$1" git_sha="$2" mode entry
  (( EUID == 0 )) || die "apply-release.sh must run as root"
  [[ -d "$stage" && ! -L "$stage" ]] || die "staging root must be a real directory"
  [[ "$(stat -c %u "$stage")" == 0 ]] || die "staging root must be owned by root"
  mode="$(stat -c %a "$stage")"
  (( (8#$mode & 0022) == 0 )) || die "staging root must not be group/world writable"

  local -a expected=(
    "SHA256SUMS"
    "agent-engine-$git_sha.tgz"
    "apply-release.sh"
    "classroom-next-$git_sha.tgz"
    "jizhi-engine-hardening.conf"
    "jizhi-web-hardening.conf"
    "manifest.json"
  )
  mapfile -t expected < <(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)
  mapfile -t actual < <(find "$stage" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  [[ "$(printf '%s\n' "${actual[@]}")" == "$(printf '%s\n' "${expected[@]}")" ]] ||
    die "staging file set mismatch"

  for entry in "${expected[@]}"; do
    local path="$stage/$entry"
    [[ -f "$path" && ! -L "$path" ]] || die "staging entry must be a regular file: $entry"
    [[ "$(stat -c %u "$path")" == 0 ]] || die "staging entry must be owned by root: $entry"
    mode="$(stat -c %a "$path")"
    (( (8#$mode & 0022) == 0 )) || die "staging entry must not be group/world writable: $entry"
  done
  if LC_ALL=C grep -q $'\r' "$stage/apply-release.sh"; then
    die "apply-release.sh contains CR bytes; LF is required"
  fi
}

validate_archive() {
  python3 - "$1" <<'PY'
import posixpath
import sys
import tarfile

archive = sys.argv[1]
seen = set()
with tarfile.open(archive, "r:gz") as handle:
    for member in handle:
        name = posixpath.normpath(member.name)
        if name in ("", "."):
            continue
        if name.startswith("/") or name == ".." or name.startswith("../"):
            raise SystemExit(f"unsafe archive member: {member.name}")
        if name in seen:
            raise SystemExit(f"duplicate archive member: {name}")
        seen.add(name)
        if member.isdev() or member.isfifo() or member.islnk():
            raise SystemExit(f"unsupported archive member type: {name}")
        if member.issym():
            target = member.linkname
            if target.startswith("/"):
                raise SystemExit(f"absolute archive link: {name}")
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if resolved == ".." or resolved.startswith("../"):
                raise SystemExit(f"archive link escapes release: {name}")
PY
}

archive_unpacked_bytes() {
  python3 - "$1" <<'PY'
import sys
import tarfile
with tarfile.open(sys.argv[1], "r:gz") as handle:
    print(sum(member.size for member in handle if member.isfile()))
PY
}

validate_release_symlinks() {
  local root="$1" link raw resolved
  while IFS= read -r -d '' link; do
    raw="$(readlink -- "$link")"
    [[ "$raw" != /* ]] || return 1
    resolved="$(readlink -e -- "$link")" || return 1
    case "$resolved" in
      "$root"/*) ;;
      *) return 1 ;;
    esac
  done < <(find "$root" -xdev -type l -print0)
}

validate_release_permissions() {
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || return 1
  [[ -z "$(find "$root" -xdev \( ! -user root -o \( ! -type l -perm /022 \) -o \
    \( -type d ! -perm -005 \) -o \( -type f ! -perm -004 \) \) -print -quit)" ]]
}

validate_release_access() {
  local root="$1" user="$2"
  [[ -z "$(runuser -u "$user" -- find "$root" -xdev \
    \( \( -type d ! -executable \) -o \( -type f ! -readable \) \) -print -quit)" ]]
}

verify_archive_payload() {
  local archive="$1" release="$2" kind="$3"
  python3 - "$archive" "$release" "$kind" <<'PY'
import hashlib
import os
import posixpath
import sys
import tarfile
from pathlib import Path

archive, release_arg, kind = sys.argv[1:]
release = Path(release_arg)
expected = set()

def clean(name: str) -> str:
    normalized = posixpath.normpath(name)
    return "" if normalized == "." else normalized

with tarfile.open(archive, "r:gz") as handle:
    for member in handle:
        name = clean(member.name)
        if not name:
            continue
        expected.add(name)
        path = release / Path(*name.split("/"))
        if member.isdir():
            if not path.is_dir() or path.is_symlink():
                raise SystemExit(f"release directory mismatch: {name}")
        elif member.issym():
            if not path.is_symlink() or os.readlink(path) != member.linkname:
                raise SystemExit(f"release link mismatch: {name}")
        elif member.isfile():
            if not path.is_file() or path.is_symlink():
                raise SystemExit(f"release file mismatch: {name}")
            source = handle.extractfile(member)
            if source is None:
                raise SystemExit(f"cannot read archived file: {name}")
            archived_hash = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                archived_hash.update(chunk)
            live_hash = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    live_hash.update(chunk)
            if archived_hash.digest() != live_hash.digest():
                raise SystemExit(f"release file content mismatch: {name}")

expected_parent_dirs = set()
for name in expected:
    parent = posixpath.dirname(name)
    while parent:
        expected_parent_dirs.add(parent)
        parent = posixpath.dirname(parent)

def allowed_extra(name: str) -> bool:
    if name == ".jizhi-release-id":
        return True
    if kind == "engine":
        return (
            name == "installed-requirements.txt"
            or name == "data"
            or name == ".venv"
            or name.startswith(".venv/")
        )
    return False

for directory, dirnames, filenames in os.walk(release, topdown=True, followlinks=False):
    base = Path(directory)
    for item in list(dirnames) + filenames:
        path = base / item
        name = path.relative_to(release).as_posix()
        implicit_parent = path.is_dir() and not path.is_symlink() and name in expected_parent_dirs
        if name not in expected and not implicit_parent and not allowed_extra(name):
            raise SystemExit(f"unexpected release entry: {name}")
PY
}

resolve_current() {
  local root link target name releases
  root="$1"
  link="$root/current"
  if [[ ! -e "$link" && ! -L "$link" ]]; then return 0; fi
  [[ -L "$link" ]] || die "$link is not a symlink"
  target="$(readlink -e "$link")" || die "$link is dangling"
  releases="$(readlink -f "$root/releases")"
  case "$target" in
    "$releases"/*) ;;
    *) die "$link escapes the release root" ;;
  esac
  [[ -d "$target" && ! -L "$target" ]] || die "$link target is not a release directory"
  name="$(basename "$target")"
  [[ "$name" =~ ^[0-9a-f]{40}-[0-9a-f]{12}$ ]] || die "$link target has an invalid release id"
  [[ "$(cat "$target/.jizhi-release-id" 2>/dev/null || true)" == "$name" ]] || die "$link target marker mismatch"
  printf '%s\n' "$target"
}

verify_engine_venv() {
  local release="$1"
  [[ -x "$release/.venv/bin/python" && -f "$release/installed-requirements.txt" ]]
  "$release/.venv/bin/python" -m pip check
  "$release/.venv/bin/python" -c 'import fastapi, fitz, langgraph, multipart, pydantic, scipy, sklearn, uvicorn'
  (cd "$release" && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -c 'from app.main import app; assert app')
  cmp -s <(LC_ALL=C "$release/.venv/bin/python" -m pip freeze) "$release/installed-requirements.txt"
}

atomic_link() {
  local target="$1" link="$2"
  ln -sfn "$target" "$link.next"
  mv -Tf "$link.next" "$link"
}

restore_current_link() {
  local root="$1" previous="$2"
  if [[ -n "$previous" && -d "$previous" ]]; then atomic_link "$previous" "$root/current"
  else rm -f -- "$root/current" "$root/current.next"
  fi
}

set_env() {
  local file="$1" key="$2" value="$3" group="$4" mode="$5" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -f "$file" ]]; then grep -v "^${key}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  install -o root -g "$group" -m "$mode" "$tmp" "$file"
  rm -f -- "$tmp"
}

wait_http() {
  local url="$1"
  for _ in {1..30}; do
    curl -fsS --max-time 15 "$url" >/dev/null && return 0
    sleep 2
  done
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
  if [[ -e "$path" || -L "$path" ]]; then cp -a "$path" "$rollback_dir/$name"
  else : >"$rollback_dir/$name.absent"
  fi
}

restore_snapshot() {
  local path="$1" name="$2"
  if [[ -f "$rollback_dir/$name.absent" ]]; then rm -f -- "$path"
  else
    rm -f -- "$path"
    cp -a "$rollback_dir/$name" "$path"
  fi
}

restore_moved_directory() {
  local source="$1" destination="$2"
  if [[ -L "$source" ]]; then rm -f -- "$source" || return 1; fi
  if [[ -d "$source" && ! -e "$destination" && ! -L "$destination" ]]; then return 0; fi
  if [[ ! -e "$source" && ! -L "$source" && -d "$destination" && ! -L "$destination" ]]; then
    mv -T "$destination" "$source"
    return
  fi
  return 1
}

run_corpus_ownership_migration() {
  local action="$1" web_release_path="$2" web_env="$3" engine_data="$4" state_dir="$5" mode
  [[ "$action" == migrate || "$action" == rollback ]] || return 2
  [[ -f "$web_env" && ! -L "$web_env" && "$(stat -c %u "$web_env")" == 0 ]] || return 1
  mode="$(stat -c %a "$web_env")"
  (( (8#$mode & 0007) == 0 )) || return 1
  [[ -d "$engine_data" && ! -L "$engine_data" && -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  (
    cd "$web_release_path"
    node - "$action" "$web_env" "$engine_data" "$state_dir" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const [action, envFile, engineData, stateDir] = process.argv.slice(2);
const backupFile = path.join(stateDir, "legacy-org-corpora.json");
const createdFile = path.join(stateDir, "created-owner-markers.json");
const corpusPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const orgPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function readProtectedEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split <= 0) continue;
    const key = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') ||
      (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function writeJsonAtomic(file, value) {
  const pending = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(pending, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(pending, file);
  } finally {
    try { fs.unlinkSync(pending); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const corpus = String(row.corpus || "");
    const orgId = String(row.org_id || row.orgId || "");
    if (!corpusPattern.test(corpus) || !orgPattern.test(orgId) || row.org_exists === false) {
      throw new Error("invalid legacy ownership row");
    }
    return { corpus, orgId };
  });
}

function markerFor(corpus) {
  return path.join(engineData, "knowledge_base", "corpora", corpus, ".jizhi-owner-org");
}

function readMarker(marker) {
  let stat;
  try { stat = fs.lstatSync(marker); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ownership marker is not a regular file");
  const raw = fs.readFileSync(marker, "utf8");
  const orgId = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!orgPattern.test(orgId) || (raw !== orgId && raw !== `${orgId}\n`)) {
    throw new Error("ownership marker is damaged");
  }
  return orgId;
}

function scanCurrentMarkers() {
  const root = path.join(engineData, "knowledge_base", "corpora");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("corpora root is unsafe");
  const rows = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("corpus directory symlink blocks rollback");
    if (!entry.isDirectory()) continue;
    const marker = path.join(root, entry.name, ".jizhi-owner-org");
    const orgId = readMarker(marker);
    if (orgId === null) continue;
    if (!corpusPattern.test(entry.name)) throw new Error("ownership marker has invalid corpus name");
    rows.push({ corpus: entry.name, orgId });
  }
  return rows.sort((left, right) => left.corpus.localeCompare(right.corpus));
}

function mergeOwnershipRows(...groups) {
  const merged = new Map();
  for (const rows of groups) {
    for (const row of rows) {
      const existing = merged.get(row.corpus);
      if (existing !== undefined && existing !== row.orgId) {
        throw new Error("ownership conflict during rollback");
      }
      merged.set(row.corpus, row.orgId);
    }
  }
  return [...merged].map(([corpus, orgId]) => ({ corpus, orgId }));
}

async function migrate(client) {
  const result = await client.query(`
    SELECT c.corpus, c.org_id, (o.id IS NOT NULL) AS org_exists
      FROM org_corpora c LEFT JOIN orgs o ON o.id = c.org_id
     ORDER BY c.corpus FOR UPDATE OF c
  `);
  const rows = normalizeRows(result.rows);
  const created = [];
  for (const row of rows) {
    const corpusDir = path.dirname(markerFor(row.corpus));
    const stat = fs.lstatSync(corpusDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("corpus directory missing");
    const existing = readMarker(markerFor(row.corpus));
    if (existing !== null && existing !== row.orgId) throw new Error("ownership marker mismatch");
    if (existing === null) created.push(row);
  }
  writeJsonAtomic(createdFile, created);
  writeJsonAtomic(backupFile, rows);
  for (const row of created) {
    const marker = markerFor(row.corpus);
    const pending = `${marker}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(pending, row.orgId + "\n", { encoding: "utf8", mode: 0o640, flag: "wx" });
      fs.renameSync(pending, marker);
    } finally {
      try { fs.unlinkSync(pending); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  for (const row of rows) {
    if (readMarker(markerFor(row.corpus)) !== row.orgId) throw new Error("ownership marker readback failed");
    const deleted = await client.query(
      "DELETE FROM org_corpora WHERE corpus = $1 AND org_id = $2",
      [row.corpus, row.orgId],
    );
    if (deleted.rowCount !== 1) throw new Error("legacy ownership delete mismatch");
  }
  const remaining = await client.query("SELECT COUNT(*)::int AS count FROM org_corpora");
  if (Number(remaining.rows[0]?.count) !== 0) throw new Error("legacy ownership table not empty");
}

async function rollback(client) {
  const backupRows = normalizeRows(JSON.parse(fs.readFileSync(backupFile, "utf8")));
  const created = normalizeRows(JSON.parse(fs.readFileSync(createdFile, "utf8")));
  for (const row of created) {
    const marker = readMarker(markerFor(row.corpus));
    if (marker !== null && marker !== row.orgId) throw new Error("ownership marker changed before rollback");
  }
  const rows = mergeOwnershipRows(backupRows, scanCurrentMarkers());
  for (const row of rows) {
    const org = await client.query("SELECT 1 FROM orgs WHERE id = $1 FOR KEY SHARE", [row.orgId]);
    if (org.rowCount !== 1) throw new Error("legacy organization missing during rollback");
  }
  await client.query("LOCK TABLE org_corpora IN EXCLUSIVE MODE");
  const current = normalizeRows((await client.query(
    "SELECT corpus, org_id FROM org_corpora ORDER BY corpus FOR UPDATE",
  )).rows);
  const expected = new Map(rows.map((row) => [row.corpus, row.orgId]));
  for (const row of current) {
    if (expected.get(row.corpus) !== row.orgId) {
      throw new Error("legacy ownership conflict during rollback");
    }
  }
  const present = new Set(current.map((row) => row.corpus));
  for (const row of rows) {
    if (!present.has(row.corpus)) {
      await client.query("INSERT INTO org_corpora (corpus, org_id) VALUES ($1, $2)", [row.corpus, row.orgId]);
    }
  }
  return created;
}

async function main() {
  const values = readProtectedEnv(envFile);
  const connectionString = values.PERSISTENCE_DATABASE_URL || values.DATABASE_URL;
  if (!connectionString) throw new Error("database URL missing");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  let created = [];
  try {
    await client.query("BEGIN");
    if (action === "migrate") await migrate(client);
    else created = await rollback(client);
    await client.query("COMMIT");
    if (action === "rollback") {
      for (const row of created) {
        const marker = markerFor(row.corpus);
        if (readMarker(marker) === row.orgId) fs.unlinkSync(marker);
      }
    }
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => {
  console.error("corpus ownership migration failed");
  process.exitCode = 1;
});
JS
  )
}

rollback_legacy_corpus_ownership() {
  local web_release_path="$1" web_env="$2" engine_data="$3" state_dir="$4"
  [[ -f "$state_dir/legacy-org-corpora.json" ]] || return 0
  run_corpus_ownership_migration rollback "$web_release_path" "$web_env" "$engine_data" "$state_dir"
}

require_space() {
  local path="$1" required="$2" label="$3" available
  available="$(df -B1 --output=avail "$path" | tail -n 1 | tr -d ' ')"
  [[ "$available" =~ ^[0-9]+$ && "$available" -ge "$required" ]] ||
    die "insufficient disk space for $label (required=$required available=${available:-unknown})"
}

prune_releases() {
  local root="$1" keep_previous="${2:-2}" current name path marker kept=0 resolved
  current="$(readlink -e "$root/current")" || return 1
  while read -r _ name; do
    [[ "$name" =~ ^[0-9a-f]{40}-[0-9a-f]{12}$ ]] || continue
    path="$root/releases/$name"
    [[ -d "$path" && ! -L "$path" ]] || continue
    marker="$(cat "$path/.jizhi-release-id" 2>/dev/null || true)"
    [[ "$marker" == "$name" ]] || continue
    resolved="$(readlink -f "$path")"
    [[ "$resolved" == "$root/releases/$name" ]] || return 1
    [[ "$resolved" == "$current" ]] && continue
    if (( kept < keep_previous )); then ((kept += 1)); continue; fi
    rm -rf -- "$resolved"
  done < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | LC_ALL=C sort -nr)
}

probe_internal_auth() {
  local response="$rollback_dir/web-health.json" negative_status
  curl -fsS --max-time 15 http://127.0.0.1:3210/api/health >"$response"
  python3 - "$response" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if body.get("status") != "ok" or body.get("engineBridge") != "ok":
    raise SystemExit("authenticated web-to-engine bridge is not healthy")
PY
  negative_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H 'x-internal-token: jizhi-release-invalid-probe' \
    http://127.0.0.1:8001/internal/v1/personalize/learning-modes)"
  [[ "$negative_status" == 401 ]] || return 1
  rm -f -- "$response"
}

validate_first_migration_state() {
  local state="$first_migration_state" mode name
  (( EUID == 0 )) || die "first-migration control must run as root"
  [[ -d "$state" && ! -L "$state" && "$(stat -c %u "$state")" == 0 ]] ||
    die "first-migration rollback state is missing or unsafe"
  mode="$(stat -c %a "$state")"
  (( (8#$mode & 0077) == 0 )) || die "first-migration rollback state must be root-only"
  grep -Fqx 'schema=1' "$state/state"
  [[ -x "$state/apply-release.sh" ]]
  for name in engine.env web.env engine.dropin web.dropin; do
    [[ -e "$state/$name" || -f "$state/$name.absent" ]]
  done
  for name in legacy-org-corpora.json created-owner-markers.json; do
    [[ -f "$state/$name" && ! -L "$state/$name" && "$(stat -c %a "$state/$name")" == 600 ]]
  done
}

accept_first_migration() {
  validate_first_migration_state
  exec 9>/run/lock/jizhi-release.lock
  flock -n 9 || { echo "another jizhi release is already running" >&2; exit 75; }
  rm -rf -- "$first_migration_state"
  echo "first migration accepted; retained rollback state removed"
}

rollback_first_migration() {
  local rollback_dir="$first_migration_state"
  local web_root=/opt/jizhi-web engine_root=/opt/jizhi-engine repo=/root/jizhi-agents
  local current_web
  validate_first_migration_state
  exec 9>/run/lock/jizhi-release.lock
  flock -n 9 || { echo "another jizhi release is already running" >&2; exit 75; }
  systemctl stop jizhi-engine.service jizhi-web.service
  current_web="$(resolve_current "$web_root")"
  [[ -n "$current_web" ]]
  rollback_legacy_corpus_ownership "$current_web" /etc/jizhi-web.env /var/lib/jizhi-engine "$rollback_dir"
  restore_current_link "$web_root" ""
  restore_current_link "$engine_root" ""
  restore_snapshot /etc/jizhi-engine.env engine.env
  restore_snapshot /etc/jizhi-web.env web.env
  restore_snapshot /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf engine.dropin
  restore_snapshot /etc/systemd/system/jizhi-web.service.d/90-hardening.conf web.dropin
  if [[ -f "$rollback_dir/web-data-moved" ]]; then
    restore_moved_directory "$repo/apps/classroom/data" /var/lib/jizhi-web
  fi
  if [[ -f "$rollback_dir/engine-data-moved" ]]; then
    restore_moved_directory "$repo/apps/agent-engine/data" /var/lib/jizhi-engine
  fi
  systemctl daemon-reload
  systemctl restart jizhi-engine.service jizhi-web.service
  wait_http http://127.0.0.1:8001/health
  wait_http http://127.0.0.1:3210/
  rm -rf -- "$rollback_dir"
  echo "first migration rolled back to the legacy runtime"
}

case "${1:-}" in
  --accept-first-migration)
    [[ "$#" == 1 ]] || die "usage: apply-release.sh --accept-first-migration"
    accept_first_migration
    exit 0
    ;;
  --rollback-first-migration)
    [[ "$#" == 1 ]] || die "usage: apply-release.sh --rollback-first-migration"
    rollback_first_migration
    exit 0
    ;;
esac

release_id="${1:?usage: apply-release.sh <full-sha-package-prefix> <staging-dir> <classroom-id>}"
staging_arg="${2:?usage: apply-release.sh <full-sha-package-prefix> <staging-dir> <classroom-id>}"
classroom_id="${3:?usage: apply-release.sh <full-sha-package-prefix> <staging-dir> <classroom-id>}"
[[ "$release_id" =~ ^[0-9a-f]{40}-[0-9a-f]{12}$ ]] || die "invalid release id"
[[ "$classroom_id" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid classroom id"
[[ "$staging_arg" == /* && ! -L "$staging_arg" ]] || die "staging path must be an absolute real path"
staging="$(readlink -f -- "$staging_arg")" || die "staging path does not resolve"
[[ "$staging" == "$staging_arg" ]] || die "staging path must already be canonical"
sha="${release_id%-*}"
artifact_prefix="${release_id##*-}"
validate_staging "$staging" "$sha"

exec 9>/run/lock/jizhi-release.lock
flock -n 9 || { echo "another jizhi release is already running" >&2; exit 75; }
cd "$staging"
sha256sum -c SHA256SUMS

web_archive="classroom-next-$sha.tgz"
engine_archive="agent-engine-$sha.tgz"
actual_artifact_prefix="$(sha256sum SHA256SUMS | cut -c1-12)"
[[ "$actual_artifact_prefix" == "$artifact_prefix" ]] || die "release id does not match packaged artifacts"
manifest_build_id="$(python3 - "$sha" "$web_archive" "$engine_archive" <<'PY'
import json
import re
import sys

git_sha, web_archive, engine_archive = sys.argv[1:]
expected_payload = {web_archive, engine_archive, "apply-release.sh", "jizhi-engine-hardening.conf", "jizhi-web-hardening.conf"}
expected_sums = expected_payload | {"manifest.json"}
sums = {}
with open("SHA256SUMS", encoding="ascii") as handle:
    for raw_line in handle:
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\r\n]+)\n?", raw_line)
        if not match or match.group(2) in sums:
            raise SystemExit("invalid SHA256SUMS")
        sums[match.group(2)] = match.group(1)
if set(sums) != expected_sums:
    raise SystemExit("SHA256SUMS file set mismatch")
with open("manifest.json", encoding="utf-8-sig") as handle:
    manifest = json.load(handle)
if set(manifest) != {"schemaVersion", "webLayout", "gitSha", "buildId", "trackedDirty", "createdAt", "files"}:
    raise SystemExit("manifest field set mismatch")
if manifest.get("schemaVersion") != 4 or manifest.get("webLayout") != "next-standalone-v1":
    raise SystemExit("manifest schema/layout mismatch")
if manifest.get("gitSha") != git_sha or manifest.get("trackedDirty") is not False:
    raise SystemExit("manifest git snapshot mismatch")
if manifest.get("files") != {name: sums[name] for name in sorted(expected_payload)}:
    raise SystemExit("manifest file hashes mismatch")
if not isinstance(manifest.get("createdAt"), str) or not manifest["createdAt"].strip():
    raise SystemExit("manifest createdAt missing")
build_id = manifest.get("buildId")
if not isinstance(build_id, str) or not build_id.strip():
    raise SystemExit("manifest buildId missing")
print(build_id.strip())
PY
)"
validate_archive "$web_archive"
validate_archive "$engine_archive"

web_root=/opt/jizhi-web
engine_root=/opt/jizhi-engine
repo=/root/jizhi-agents
web_release="$web_root/releases/$release_id"
engine_release="$engine_root/releases/$release_id"
install -d -m 0755 "$web_root/releases" "$engine_root/releases" /srv/jizhi-engine
old_web="$(resolve_current "$web_root")"
old_engine="$(resolve_current "$engine_root")"
if [[ -z "$old_web" && -n "$old_engine" ]] || [[ -n "$old_web" && -z "$old_engine" ]]; then
  die "web and engine current must both exist or both be absent"
fi
[[ ! -e "$first_migration_state" && ! -L "$first_migration_state" ]] ||
  die "first migration awaits --accept-first-migration or --rollback-first-migration"
first_migration=0
[[ -n "$old_web" ]] || first_migration=1

reuse_release=0
if [[ -e "$web_release" || -L "$web_release" || -e "$engine_release" || -L "$engine_release" ]]; then
  if [[ -d "$web_release" && ! -L "$web_release" && -d "$engine_release" && ! -L "$engine_release" ]] &&
    [[ "$(cat "$web_release/.jizhi-release-id" 2>/dev/null || true)" == "$release_id" ]] &&
    [[ "$(cat "$engine_release/.jizhi-release-id" 2>/dev/null || true)" == "$release_id" ]]; then
    validate_release_permissions "$web_release"
    validate_release_permissions "$engine_release"
    validate_release_symlinks "$web_release"
    validate_release_symlinks "$engine_release"
    verify_archive_payload "$web_archive" "$web_release" web
    verify_archive_payload "$engine_archive" "$engine_release" engine
    [[ "$(cat "$web_release/.next/BUILD_ID")" == "$manifest_build_id" ]]
    verify_engine_venv "$engine_release"
    reuse_release=1
  else
    die "existing release is partial or does not match: $release_id"
  fi
fi

if [[ "$reuse_release" == 0 ]]; then
  web_unpacked="$(archive_unpacked_bytes "$web_archive")"
  engine_unpacked="$(archive_unpacked_bytes "$engine_archive")"
  prior_venv=
  [[ -n "$old_engine" && -d "$old_engine/.venv" ]] && prior_venv="$old_engine/.venv"
  [[ -z "$prior_venv" && -d "$repo/apps/agent-engine/.venv" ]] && prior_venv="$repo/apps/agent-engine/.venv"
  if [[ -n "$prior_venv" ]]; then
    venv_estimate="$(( $(du -sb "$prior_venv" | cut -f1) * 12 / 10 ))"
  else
    venv_estimate="$(( engine_unpacked * 6 + 536870912 ))"
  fi
  reserve=268435456
  if [[ "$(stat -c %d "$web_root")" == "$(stat -c %d "$engine_root")" ]]; then
    require_space "$web_root" "$(( web_unpacked + engine_unpacked + venv_estimate + reserve ))" "web+engine release"
  else
    require_space "$web_root" "$(( web_unpacked + reserve ))" "web release"
    require_space "$engine_root" "$(( engine_unpacked + venv_estimate + reserve ))" "engine release"
  fi
fi

web_incoming=
engine_incoming=
live_mutation_started=0
cleanup_incoming() {
  local status=$?
  trap '' HUP INT TERM
  [[ -z "${web_incoming:-}" ]] || rm -rf -- "$web_incoming"
  [[ -z "${engine_incoming:-}" ]] || rm -rf -- "$engine_incoming"
  if [[ "$status" != 0 && "$live_mutation_started" == 0 && "$reuse_release" == 0 ]]; then
    [[ ! -e "$web_release" && ! -L "$web_release" ]] || rm -rf -- "$web_release"
    [[ ! -e "$engine_release" && ! -L "$engine_release" ]] || rm -rf -- "$engine_release"
  fi
  return "$status"
}
trap cleanup_incoming EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

id -u jizhi-engine >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin jizhi-engine
id -u jizhi-web >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin jizhi-web

if [[ "$reuse_release" == 0 ]]; then
  web_incoming="$(mktemp -d "$web_root/releases/.incoming-$release_id.XXXXXX")"
  engine_incoming="$(mktemp -d "$engine_root/releases/.incoming-$release_id.XXXXXX")"
  tar --no-same-owner --no-same-permissions -xzf "$web_archive" -C "$web_incoming"
  tar --no-same-owner --no-same-permissions -xzf "$engine_archive" -C "$engine_incoming"
  [[ -s "$web_incoming/.next/BUILD_ID" ]]
  [[ "$(cat "$web_incoming/.next/BUILD_ID")" == "$manifest_build_id" ]]
  [[ -f "$web_incoming/server.js" && -f "$web_incoming/start-standalone.mjs" ]]
  [[ -d "$web_incoming/.next/static" && -d "$web_incoming/public" ]]
  [[ -z "$(find "$web_incoming/data" "$web_incoming/.next/cache" -mindepth 1 -print -quit)" ]]
  [[ -d "$web_incoming/node_modules/.pnpm" ]]
  compgen -G "$web_incoming/node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node" >/dev/null
  compgen -G "$web_incoming/node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.*" >/dev/null
  node --check "$web_incoming/start-standalone.mjs"
  node --check "$web_incoming/server.js"
  validate_release_symlinks "$web_incoming"
  [[ -f "$engine_incoming/app/main.py" && -f "$engine_incoming/requirements.production.lock" ]]
  install -d -m 0755 "$engine_incoming/data"
  python3 -m venv "$engine_incoming/.venv"
  "$engine_incoming/.venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
    --index-url https://pypi.org/simple --require-hashes -r "$engine_incoming/requirements.production.lock"
  "$engine_incoming/.venv/bin/python" -m pip freeze >"$engine_incoming/installed-requirements.txt"
  verify_engine_venv "$engine_incoming"
  printf '%s\n' "$release_id" >"$web_incoming/.jizhi-release-id"
  printf '%s\n' "$release_id" >"$engine_incoming/.jizhi-release-id"
  chmod 0444 "$web_incoming/.jizhi-release-id" "$engine_incoming/.jizhi-release-id"
  chown -hR root:root "$web_incoming" "$engine_incoming"
  chmod -R a+rX,go-w "$web_incoming" "$engine_incoming"
  validate_release_permissions "$web_incoming"
  validate_release_permissions "$engine_incoming"
  validate_release_access "$web_incoming" jizhi-web
  validate_release_access "$engine_incoming" jizhi-engine
  verify_archive_payload "$web_archive" "$web_incoming" web
  verify_archive_payload "$engine_archive" "$engine_incoming" engine
  mv -T "$web_incoming" "$web_release"
  web_incoming=
  mv -T "$engine_incoming" "$engine_release"
  engine_incoming=
fi

validate_release_access "$web_release" jizhi-web
validate_release_access "$engine_release" jizhi-engine
runuser -u jizhi-web -- node --check "$web_release/start-standalone.mjs"
runuser -u jizhi-engine -- "$engine_release/.venv/bin/python" -c 'import fastapi, uvicorn'

rollback_dir="$(mktemp -d /var/tmp/jizhi-release-rollback.XXXXXX)"
engine_data_moved=0
web_data_moved=0
snapshot /etc/jizhi-engine.env engine.env
snapshot /etc/jizhi-web.env web.env
snapshot /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf engine.dropin
snapshot /etc/systemd/system/jizhi-web.service.d/90-hardening.conf web.dropin
live_mutation_started=1

rollback() {
  local cause="${1:-$?}" failed=0
  trap - ERR
  trap '' HUP INT TERM
  set +e
  systemctl stop jizhi-engine.service jizhi-web.service || failed=1
  if rollback_legacy_corpus_ownership "$web_release" /etc/jizhi-web.env /var/lib/jizhi-engine "$rollback_dir"; then
    restore_current_link "$web_root" "$old_web" || failed=1
    restore_current_link "$engine_root" "$old_engine" || failed=1
    restore_snapshot /etc/jizhi-engine.env engine.env || failed=1
    restore_snapshot /etc/jizhi-web.env web.env || failed=1
    restore_snapshot /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf engine.dropin || failed=1
    restore_snapshot /etc/systemd/system/jizhi-web.service.d/90-hardening.conf web.dropin || failed=1
    if [[ "$web_data_moved" == 1 ]]; then restore_moved_directory "$repo/apps/classroom/data" /var/lib/jizhi-web || failed=1; fi
    if [[ "$engine_data_moved" == 1 ]]; then restore_moved_directory "$repo/apps/agent-engine/data" /var/lib/jizhi-engine || failed=1; fi
    systemctl daemon-reload || failed=1
    systemctl restart jizhi-engine.service jizhi-web.service || failed=1
    wait_http http://127.0.0.1:8001/health || failed=1
    wait_http http://127.0.0.1:3210/ || failed=1
  else
    failed=1
  fi
  if [[ "$failed" == 0 ]]; then
    [[ "$reuse_release" != 0 ]] || rm -rf -- "$web_release" "$engine_release"
    rm -rf -- "$rollback_dir"
    echo "release failed; previous runtime and mutable data restored" >&2
    exit "$cause"
  fi
  {
    printf 'web_current=%s\n' "$(readlink "$web_root/current" 2>&1)"
    printf 'engine_current=%s\n' "$(readlink "$engine_root/current" 2>&1)"
    systemctl status --no-pager jizhi-web.service jizhi-engine.service
    journalctl -u jizhi-web.service -u jizhi-engine.service -n 100 --no-pager
  } >"$rollback_dir/failure-evidence.log" 2>&1
  echo "release and rollback both failed; root-only evidence preserved at $rollback_dir" >&2
  exit 1
}
trap 'rollback "$?"' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

chmod 0600 "$repo/apps/agent-engine/.env" "$repo/apps/classroom/.env.local"
[[ "$(stat -c %a "$repo/apps/agent-engine/.env")" == 600 ]]
[[ "$(stat -c %a "$repo/apps/classroom/.env.local")" == 600 ]]
if [[ ! -f /etc/jizhi-engine.env ]]; then
  install -o root -g root -m 0600 "$repo/apps/agent-engine/.env" /etc/jizhi-engine.env
fi
if [[ ! -f /etc/jizhi-web.env ]]; then
  install -o root -g jizhi-web -m 0640 "$repo/apps/classroom/.env.local" /etc/jizhi-web.env
fi
[[ "$(stat -c %a /etc/jizhi-engine.env)" == 600 ]]
[[ "$(stat -c %a /etc/jizhi-web.env)" == 640 ]]

need_engine_migration=0
need_web_migration=0
if [[ -e /var/lib/jizhi-engine || -L /var/lib/jizhi-engine ]]; then
  [[ -d /var/lib/jizhi-engine && ! -L /var/lib/jizhi-engine ]]
  [[ -L "$repo/apps/agent-engine/data" ]]
  [[ "$(readlink -e "$repo/apps/agent-engine/data")" == /var/lib/jizhi-engine ]]
else
  [[ -d "$repo/apps/agent-engine/data" && ! -L "$repo/apps/agent-engine/data" ]]
  [[ "$(stat -c %d "$repo/apps/agent-engine/data")" == "$(stat -c %d /var/lib)" ]]
  need_engine_migration=1
fi
if [[ -e /var/lib/jizhi-web || -L /var/lib/jizhi-web ]]; then
  [[ -d /var/lib/jizhi-web && ! -L /var/lib/jizhi-web ]]
  [[ -L "$repo/apps/classroom/data" ]]
  [[ "$(readlink -e "$repo/apps/classroom/data")" == /var/lib/jizhi-web ]]
else
  [[ -d "$repo/apps/classroom/data" && ! -L "$repo/apps/classroom/data" ]]
  [[ "$(stat -c %d "$repo/apps/classroom/data")" == "$(stat -c %d /var/lib)" ]]
  need_web_migration=1
fi
systemctl stop jizhi-engine.service jizhi-web.service
fault_point services-stopped-for-data-migration
if [[ "$need_engine_migration" == 1 ]]; then
  engine_data_moved=1
  : >"$rollback_dir/engine-data-moved"
  mv -T "$repo/apps/agent-engine/data" /var/lib/jizhi-engine
  fault_point engine-data-move
  ln -s /var/lib/jizhi-engine "$repo/apps/agent-engine/data"
  fault_point engine-data-link
fi
if [[ "$need_web_migration" == 1 ]]; then
  web_data_moved=1
  : >"$rollback_dir/web-data-moved"
  mv -T "$repo/apps/classroom/data" /var/lib/jizhi-web
  fault_point web-data-move
  ln -s /var/lib/jizhi-web "$repo/apps/classroom/data"
  fault_point web-data-link
fi

run_corpus_ownership_migration migrate "$web_release" /etc/jizhi-web.env /var/lib/jizhi-engine "$rollback_dir"
fault_point corpus-ownership-migrated

install -d -o jizhi-web -g jizhi-web -m 0750 /var/cache/jizhi-web
chown -R jizhi-web:jizhi-engine /var/lib/jizhi-web
chmod -R o-rwx /var/lib/jizhi-web
chmod -R g+rX /var/lib/jizhi-web
find /var/lib/jizhi-web -type d -exec chmod g+s {} +
chown -R jizhi-engine:jizhi-web /var/lib/jizhi-engine
chmod -R o-rwx /var/lib/jizhi-engine
chmod -R g+rX /var/lib/jizhi-engine
find /var/lib/jizhi-engine -type d -exec chmod g+s {} +
chown -R jizhi-web:jizhi-web /var/cache/jizhi-web
install -d -o jizhi-web -g jizhi-engine -m 2750 /var/lib/jizhi-web/usage
while IFS= read -r -d '' marker; do
  chown jizhi-engine:jizhi-web "$marker"
  chmod 0640 "$marker"
  runuser -u jizhi-engine -- test -r "$marker"
done < <(find /var/lib/jizhi-engine/knowledge_base/corpora -mindepth 2 -maxdepth 2 \
  -type f -name .jizhi-owner-org -print0)

token="$(sed -n 's/^AI_SERVICE_TOKEN=//p' /etc/jizhi-engine.env | tail -n 1)"
if ! token_is_safe "$token"; then token="$(openssl rand -hex 32)"; fi
token_is_safe "$token"
set_env /etc/jizhi-engine.env AI_SERVICE_TOKEN "$token" root 0600
set_env /etc/jizhi-engine.env CLASSROOM_BASE_URL http://127.0.0.1:3210 root 0600
set_env /etc/jizhi-web.env GROUNDING_TOKEN "$token" jizhi-web 0640
set_env /etc/jizhi-web.env GROUNDING_URL http://127.0.0.1:8001 jizhi-web 0640
set_env /etc/jizhi-web.env ENGINE_DATA_DIR /var/lib/jizhi-engine jizhi-web 0640
set_env /etc/jizhi-web.env ACCOUNTS_DIR /var/lib/jizhi-web/accounts jizhi-web 0640
set_env /etc/jizhi-web.env RENDER_JOB_OWNERS_DIR /var/lib/jizhi-web/render-job-owners jizhi-web 0640
[[ "$(sed -n 's/^GROUNDING_TOKEN=//p' /etc/jizhi-web.env | tail -n 1)" == "$token" ]]
grep -Fqx 'CLASSROOM_BASE_URL=http://127.0.0.1:3210' /etc/jizhi-engine.env
grep -Fqx 'GROUNDING_URL=http://127.0.0.1:8001' /etc/jizhi-web.env
grep -Fqx 'ACCOUNTS_DIR=/var/lib/jizhi-web/accounts' /etc/jizhi-web.env
grep -Fqx 'RENDER_JOB_OWNERS_DIR=/var/lib/jizhi-web/render-job-owners' /etc/jizhi-web.env
! grep -Fq '/root/jizhi-agents' /etc/jizhi-web.env
! grep -Fq '/srv/jizhi-repo' /etc/jizhi-web.env
[[ "$(stat -c %a /etc/jizhi-engine.env)" == 600 ]]
[[ "$(stat -c %a /etc/jizhi-web.env)" == 640 ]]
fault_point environment-configured

install -d -m 0755 /etc/systemd/system/jizhi-engine.service.d /etc/systemd/system/jizhi-web.service.d
install -o root -g root -m 0644 jizhi-engine-hardening.conf /etc/systemd/system/jizhi-engine.service.d/90-hardening.conf
install -o root -g root -m 0644 jizhi-web-hardening.conf /etc/systemd/system/jizhi-web.service.d/90-hardening.conf
fault_point hardening-installed
atomic_link "$engine_release" "$engine_root/current"
fault_point engine-release-link
atomic_link "$web_release" "$web_root/current"
fault_point web-release-link
systemctl daemon-reload
systemctl restart jizhi-engine.service jizhi-web.service
fault_point services-restarted

wait_http http://127.0.0.1:8001/health
wait_http http://127.0.0.1:3210/
wait_http http://127.0.0.1:3210/api/auth
wait_http http://127.0.0.1:3210/admin/org
wait_http "http://127.0.0.1:3210/api/classroom?id=$classroom_id"
wait_http "http://127.0.0.1:3210/classroom/$classroom_id"
fault_point smoke-complete

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
engine_pid="$(systemctl show -p MainPID --value jizhi-engine.service)"
web_pid="$(systemctl show -p MainPID --value jizhi-web.service)"
[[ "$(cat "/proc/$engine_pid/root/srv/jizhi-engine/.jizhi-release-id")" == "$release_id" ]]
[[ "$(cat "/proc/$web_pid/root/opt/jizhi-web/current/.jizhi-release-id")" == "$release_id" ]]
[[ "$(cat "/proc/$web_pid/root/opt/jizhi-web/current/.next/BUILD_ID")" == "$manifest_build_id" ]]
[[ "$(systemctl show -p WorkingDirectory --value jizhi-web.service)" == /opt/jizhi-web/current ]]
web_exec="$(systemctl show -p ExecStart --value jizhi-web.service)"
[[ "$web_exec" == *"/opt/jizhi-web/current/start-standalone.mjs"* ]]
[[ "$web_exec" != *"/root/jizhi-agents"* ]]
probe_internal_auth
fault_point internal-auth-verified

if [[ "$first_migration" == 1 ]]; then
  printf 'schema=1\nrelease_id=%s\n' "$release_id" >"$rollback_dir/state"
  install -o root -g root -m 0700 "$staging/apply-release.sh" "$rollback_dir/apply-release.sh"
  install -d -o root -g root -m 0700 "$(dirname "$first_migration_state")"
  trap '' HUP INT TERM
  mv -T "$rollback_dir" "$first_migration_state"
  rollback_dir="$first_migration_state"
fi
trap - ERR HUP INT TERM
if [[ "$first_migration" == 1 ]]; then
  echo "first migration rollback retained: $first_migration_state"
  echo "accept after full E2E: $first_migration_state/apply-release.sh --accept-first-migration"
  echo "rollback: $first_migration_state/apply-release.sh --rollback-first-migration"
else
  rm -rf -- "$rollback_dir"
fi
prune_releases "$web_root" 2 || echo "warning: web release retention cleanup failed" >&2
prune_releases "$engine_root" 2 || echo "warning: engine release retention cleanup failed" >&2
echo "release=$release_id web=standalone engine=ok users=nonroot auth=verified"
