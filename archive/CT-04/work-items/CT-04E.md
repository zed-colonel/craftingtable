# CT-04E — Visual change-request workflow and AQ-01 dogfood

**Parent:** CT-04  
**Risk:** High  
**Dependencies:** accepted CT-04D  
**Primary areas:** repository/change-request/worktree browser views, diff viewer, async route identity, operator controls, integration acceptance, documentation

## Objective

Expose the accepted CT-04A through CT-04D capabilities as one coherent visual supervisory workflow. From the browser, the operator can register a repository, bind it to a project, prepare a change request for AQ-01, provision a managed worktree, inspect identity and operation state, capture a diff snapshot, and request safe cleanup.

This slice adds no new Git authority. It exposes only previously accepted service commands.

## Required outcomes

- add repository list, registration, detail, and project-binding views;
- integrate repository state into project and admitted work-item views;
- add change-request creation from an admitted work item;
- show target ref, exact base SHA, branch, managed path, operation state, and open generation placeholder;
- add explicit provision, reconcile, refresh-diff, and safe-cleanup controls with confirmation where appropriate;
- add file/status summary and safe unified diff view;
- show truncation, unsupported content, dirty cleanup blockers, identity mismatch, uncertain operations, and reconciliation state prominently;
- never call a worktree provisioned/clean/diffed item “ready”, “verified”, “reviewed”, or “mergeable”;
- key all async responses to workspace and resource identity;
- handle picker, direct URL, and browser history transitions;
- update architecture, security, operations, route inventory, and UI documentation;
- execute the AQ-01 manual dogfood path against an operator-selected local ActionQueue repository;
- write parent completion and final independent review records.

## Browser temporal matrix

Required tests cover late success and late failure after:

```text
workspace picker switch
direct route navigation
browser back/forward
repository detail change
change-request detail change
diff snapshot change
logout/session invalidation
```

Abort requests where possible, but still compare captured identity before state application.

## Required adversarial coverage

```text
UI-ROUTE-IDENTITY
UI-LATE-RESULT
UI-AUTHORIZATION
UI-RENDER-SAFETY
UI-OPERATION-STATE
UI-NONREADINESS
REGRESSION-CT01-CT03
DOGFOOD-AQ01
```

## Non-goals

- no coding-agent launch;
- no terminal;
- no arbitrary file browser;
- no command output console beyond bounded Git-operation evidence;
- no hunk editing;
- no check runner;
- no code-review agent;
- no merge button.

## Exit gate

```text
The complete AQ-01 path can be supervised visually from the browser.
The daemon remains authoritative across refresh and restart.
Late results from another workspace/resource never appear in the current view.
The diff is safe, bounded, and tied to exact immutable evidence.
Dirty cleanup is visibly blocked and clean cleanup removes only the managed worktree.
The final parent review confirms no CT-05+ behavior leaked into production code.
```
