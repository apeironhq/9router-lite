$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/apeironhq/9router-lite.git'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath '.git')) {
    git init -b main
    if ($LASTEXITCODE -ne 0) { throw 'git init gagal' }
}

$exclude = @'
/node_modules/
**/node_modules/
/.next/
/.vercel/
/coverage/
/dist/
/out/
.env*
!.env.example
*.sqlite
*.sqlite3
*.db
*.db-journal
*.log
.codex-supabase-smoke.mjs
'@
Set-Content -LiteralPath '.git/info/exclude' -Value $exclude -Encoding utf8

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
    git remote add origin $repo
} elseif ($origin.Trim() -ne $repo) {
    throw "Remote origin berbeda: $origin"
}

git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add gagal' }
$staged = @(git diff --cached --name-only)
if ($staged | Where-Object { $_ -match '(^|/)(\.env(\.|$)|node_modules/|\.next/|\.vercel/|.*\.(sqlite3?|db|log)$)' -and $_ -ne '.env.example' }) {
    throw 'Ada file rahasia atau hasil build yang ter-stage. Push dibatalkan.'
}
if ($staged.Count -gt 0) {
    git -c user.name='9Router migration' -c user.email='migration@users.noreply.github.com' commit -m 'Prepare 9Router for Vercel and Supabase'
    if ($LASTEXITCODE -ne 0) { throw 'git commit gagal' }
}

git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch gagal' }
git merge --allow-unrelated-histories -X ours --no-edit origin/main
if ($LASTEXITCODE -ne 0) { throw 'git merge gagal; periksa konflik sebelum push' }
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw 'git push gagal' }
Write-Host 'Push berhasil.'
