# Git workflow

Use `main` for release-ready history and `develop` as the integration branch. Work never starts directly on either branch.

- `feature/<short-name>` from `develop` for new functionality.
- `fix/<short-name>` from `develop` for ordinary corrections.
- `release/<version>` from `develop` for release preparation.
- `hotfix/<short-name>` from `main` for urgent released-code fixes; integrate into both `main` and `develop`.

Use small Conventional Commits (`feat`, `fix`, `test`, `build`, `refactor`, `docs`, `chore`) with a relevant scope. Keep credentials/generated outputs ignored. Run the checks relevant to each change before integration; feature/fix branches merge into `develop` with a reviewed merge/PR. Releases merge into `main` and receive an annotated version tag. Do not force-push shared history.

Current work is on `feature/domain-identity-admin-foundations`. Keep it reviewable in focused commits; publishing/merging is a separate action from local implementation. The remote remains `origin` from the existing repository setup.
