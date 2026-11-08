# Git workflow

Use `main` for release-ready history and `develop` as the integration branch. Work never starts directly on either branch.

- `feature/<short-name>` from `develop` for new functionality.
- `fix/<short-name>` from `develop` for ordinary corrections.
- `release/<version>` from `develop` for release preparation.
- `hotfix/<short-name>` from `main` for urgent released-code fixes; integrate into both `main` and `develop`.

Use small Conventional Commits (`feat`, `fix`, `test`, `build`, `refactor`, `docs`, `chore`) with a relevant scope. Keep credentials/generated outputs ignored. Run the checks relevant to each change before integration; feature/fix branches merge into `develop` with a reviewed merge/PR. Releases merge into `main` and receive an annotated version tag. Do not force-push shared history.

Example: `feature/domain-identity-admin-foundations`. Keep work reviewable in focused commits, then review the diff/check results and finish the feature with an explicit non-fast-forward merge into local `develop`. Retain the feature branch for traceability. `main` changes only through the release/hotfix workflow. Publishing is separate; local implementation does not imply a push. The remote remains `origin`.
