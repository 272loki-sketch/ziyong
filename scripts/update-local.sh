#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="local"
UPSTREAM="${LIYUAN_UPSTREAM:-origin/main}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${LIYUAN_BACKUP_DIR:-/root/backups}/liyuan-update-${STAMP}"
NODE="${LIYUAN_NODE:-/opt/node22/bin/node}"

cd "$ROOT"

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
	printf 'Refusing to update: checkout %s first.\n' "$BRANCH" >&2
	exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
	printf 'Refusing to update: the worktree is not clean. Commit or stash changes first.\n' >&2
	exit 1
fi

mkdir -p "$BACKUP_ROOT"
git bundle create "$BACKUP_ROOT/repository.bundle" --all

project_data=(
	liyuan.agent.json liyuan.agent.meta.json liyuan.config.json
	.liyuan .liyuan-stage-skills .liyuan-memory .liyuan-state
	.liyuan-personas.json liyuan-profiles data
)
existing=()
for path in "${project_data[@]}"; do
	[[ -e "$path" ]] && existing+=("$path")
done
if ((${#existing[@]})); then
	tar -czpf "$BACKUP_ROOT/project-data.tgz" "${existing[@]}"
fi
if [[ -d /var/lib/liyuan/agent ]]; then
	tar -czpf "$BACKUP_ROOT/agent-data.tgz" -C /var/lib/liyuan agent
fi
sha256sum "$BACKUP_ROOT"/* > "$BACKUP_ROOT/SHA256SUMS"

git fetch "${UPSTREAM%%/*}" --tags
if git merge-base --is-ancestor "$UPSTREAM" HEAD; then
	printf 'Already up to date. Backup: %s\n' "$BACKUP_ROOT"
	exit 0
fi

printf 'Merging %s into %s...\n' "$UPSTREAM" "$BRANCH"
if ! git merge --no-edit "$UPSTREAM"; then
	printf '\nMerge stopped on conflicts. The service was not restarted.\n' >&2
	printf 'Resolve the files, run tests, then commit; or run: git merge --abort\n' >&2
	printf 'Backup: %s\n' "$BACKUP_ROOT" >&2
	exit 2
fi

printf 'Installing dependencies...\n'
npm install --no-audit --no-fund
npm --prefix web install --no-audit --no-fund

printf 'Running backend tests...\n'
"$NODE" --test --experimental-strip-types test/*.test.ts
printf 'Checking and building frontend...\n'
npm --prefix web run typecheck
npm --prefix web run build

if command -v systemctl >/dev/null 2>&1 && systemctl cat liyuan >/dev/null 2>&1; then
	systemctl restart liyuan
	for _ in {1..20}; do
		if curl --fail --silent http://127.0.0.1:7620/healthz >/dev/null; then
			printf 'Update complete. Service is healthy. Backup: %s\n' "$BACKUP_ROOT"
			exit 0
		fi
		sleep 1
	done
	printf 'Update installed, but the HTTP health check failed. Inspect: journalctl -u liyuan\n' >&2
	exit 3
fi

printf 'Update complete. No liyuan systemd service was found. Backup: %s\n' "$BACKUP_ROOT"
