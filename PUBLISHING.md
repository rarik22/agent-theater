# Publishing

Everything is committed locally in `E:\agent-theater-release` on branch `main`. Nothing has been
pushed or published yet. Run these steps when github.com resolves on this machine and the empty
repository exists.

## 1. GitHub

1. Create the repository on github.com: owner `tarqmamdouh`, name `agent-theater`, **Public**, and
   leave it empty (no README, licence or .gitignore).
2. Check that GitHub resolves and answers:

   ```sh
   nslookup github.com
   git ls-remote https://github.com/tarqmamdouh/agent-theater.git
   ```

   The second command prints nothing (an empty repository) and exits without an error.
3. Check that the commits carry the author name and e-mail you want public (`git log --format='%an <%ae>'`).
   To change them before the first push:

   ```sh
   cd E:/agent-theater-release
   git config user.name "Your Name"
   git config user.email "you@users.noreply.github.com"
   git rebase -r --root --exec "git commit --amend --no-edit --reset-author"
   ```

4. Push:

   ```sh
   cd E:/agent-theater-release
   git remote add origin https://github.com/tarqmamdouh/agent-theater.git
   git push -u origin main
   git tag v0.1.0
   git push origin v0.1.0
   ```

5. Check both installs from GitHub:

   ```sh
   npx -y github:tarqmamdouh/agent-theater --version     # prints 0.1.0
   claude plugin install agent-theater --marketplace tarqmamdouh/agent-theater
   ```

   In a Claude Code session the README's line works too:
   `/plugin install agent-theater --marketplace tarqmamdouh/agent-theater`.

   The plugin carries the app, so it works from GitHub alone; npm is not needed for it.

## 2. npm (optional, for `npx agent-theater`)

The package name `agent-theater` was free on 2026-11-20.

```sh
cd E:/agent-theater-release
npm view agent-theater name        # "404 Not Found" means the name is still free
npm login
npm publish --dry-run              # lists the files; no tests, plugin hooks, local/ or qa-local/
npm publish
npx -y agent-theater@0.1.0 --version   # prints 0.1.0
```

If your npm account uses two-factor authentication, `npm publish` asks for a one-time code (or pass
`--otp <code>`).

## Later releases

1. Update `CHANGELOG.md`.
2. Bump the same version in `package.json` and `.claude-plugin/plugin.json`. Plugin users get the
   new version through `claude plugin update agent-theater` once it is pushed.
3. `node --test test/`, `claude plugin validate --strict .`, `claude plugin test .`.
4. Commit, tag `v<version>`, `git push && git push --tags`, then `npm publish`.
