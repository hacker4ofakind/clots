# Clots

## From a feature idea to a merge

Every large feature, from the first idea to the merge, goes through these steps in order.

1. **Brainstorm** with `superpowers:brainstorming`. It settles the design with the user and ends in a spec in `.superpowers/specs/`. When the feature changes how Clots works as a whole, edit the parent design (`.superpowers/specs/2026-10-10-clots-design.md`) in place instead of writing a new spec.
2. **Plan** with `superpowers:writing-plans`. The plan goes in `.superpowers/plans/` and is built on the spec.
3. **Stress-test** the plan with `superpowers:stress-testing-plans`. Fold the fixes into the plan, and put the design questions to the user.
4. **Execute** in a session of its own, started for the user, on a new branch, with `superpowers:executing-plans`. It commits once at the end, and doesn't push.
5. **Verify by hand** whatever can be checked without the user, following the plan's Manual Verification Checklist. Use a session or subagent with the built-in browser for Discord, started in bypass permissions mode. Give its failures to the executor session to fix, and run those checks again.
6. **Open the PR** once everything passes: commit, push, then open the pull request.
7. **Run `coderabbit-plus pr <number>`** in the background. The executor session reads the output, checks each finding against the code, fixes the ones that hold up, skips the rest with a reason, then commits and pushes.
8. **Run `coderabbit-plus commit <branch>`** in the background, and handle it the same way.
9. **Update the docs** that mention code or features the change touched: the spec's status line, the plan's Implementation Notes (with the live-check results), the README, and anything else that refers to them. Commit and push.
10. **Squash-merge** the PR, deleting the branch on GitHub. Then delete it locally, and return the checkout to `master`.

Throughout:
- **Spec and plan describe the design as built.** When the build changes a decision, edit them in place, with no change notes.
- **Open Docker Desktop before any work,** and check that `docker info` succeeds.
