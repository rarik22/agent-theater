# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Terms for contributions

Agent Theater is licensed under the PolyForm Internal Use License 1.0.0, and its owner may change or
add licences for later versions. So that the owner can keep doing that, every contribution is accepted
under these terms:

- By opening a pull request or otherwise submitting a contribution, you confirm that you wrote it (or
  have the right to submit it) and you grant the owner of this repository (tarqmamdouh) a perpetual,
  worldwide, non-exclusive, royalty-free, irrevocable licence to use, copy, change, sublicense and
  distribute your contribution under any terms, including the project's current licence and any later
  one.
- You keep the copyright in your contribution.
- If you cannot agree to this, please open an issue describing the change instead of sending code.

## Before you send a change

- `node --test test/` passes. Tests use synthetic fixtures only: never add real transcripts, journals,
  paths, names or secrets.
- For plugin changes: `claude plugin validate --strict .` and `claude plugin test .` pass.
- Keep the server read-only on its sources, bound to 127.0.0.1, and free of npm dependencies.
- Keep public mode safe: nothing from a command, path, prompt or description may reach the public
  state.
- Changes to the stage keep the pixel art crisp: whole pixels, palette colours only, no blending.
