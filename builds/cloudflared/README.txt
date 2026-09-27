The tunnel binary a paired installer carries.

This folder is build output, not source. Nothing in the repository holds
cloudflared; it is fetched, and the lock file beside it records which release
and which exact bytes a build shipped.

  node scripts/fetch-cloudflared.js --win     the binary a Windows installer needs
  node scripts/fetch-cloudflared.js           this machine, for local testing

  builds/cloudflared/cloudflared.exe          Windows (packaged into the installer)
  builds/cloudflared/cloudflared              macOS or Linux (development only)
  builds/cloudflared/cloudflared.lock.json    version + SHA-256, committed

WHY THE LOCK FILE IS COMMITTED AND THE BINARY IS NOT
----------------------------------------------------
The lock file is small, it is the only record of what a given installer
contains, and reviewing it is the moment to check a downloaded hash against the
release notes. The binary is ~40 MB of somebody else's code and does not belong
in a git history. `.gitignore` keeps the folder's contents out of git while
letting the lock file and this note through.

FIRST RUN PINS, LATER RUNS VERIFY
---------------------------------
The first download has no hash to compare against, so it records the one it
computed and tells you to check it. After that a mismatch is refused outright:
either the release changed under a version that was supposed to be immutable, or
the download is not what it claims to be. Neither is something to discover at a
shop. If you have verified a new hash yourself, `--force` accepts it.

THIS FOLDER IS NOT CLEARED BETWEEN BUILDS, ON PURPOSE
-----------------------------------------------------
`builds/shuttlezone-seed/` is cleared before every build, because it holds
things that identify one shop and a leftover seed would go out in the next
seller's installer wearing the wrong shop's identity. This folder holds none of
that - the binary is the same third-party executable for every seller - so
clearing it would only mean re-downloading 40 MB before each build.

Only an installer built with a seed that declares a `tunnel` ships this binary
or starts it. A stock Posnic contains neither. Its licence and attribution are
recorded in `THIRD-PARTY-NOTICES.md`.
