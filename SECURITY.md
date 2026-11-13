# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: on this repository, go to **Security → Report a vulnerability**
([private vulnerability reporting](https://github.com/atannex/bridge-js/security/advisories/new)).
If you cannot use GitHub, email atangageihlekecollins@gmail.com with "SECURITY: @atannex/bridge" in the subject.

Include what you can: the affected version, a description of the problem and its impact, and steps or code to
reproduce it.

## What to expect

- An acknowledgement within 3 working days.
- An assessment, and a plan or a fix date, within 10 working days.
- A fixed release, published from CI with npm provenance, and a GitHub security advisory crediting you (unless you
  prefer not to be named).

Please give us a reasonable time to release a fix before you disclose the issue publicly.

## Supported versions

| Version | Security fixes |
| ------- | -------------- |
| 1.x     | Yes            |

## Scope

In scope: this package (`@atannex/bridge` and its subpath exports), for example credentials sent to the wrong origin,
tokens exposed in logs or errors, or requests repeated when they must not be.

Out of scope here: the Laravel side (`atannex/bridge`; report to that repository) and vulnerabilities in your own
application code or in dependencies you install alongside this package.

## Verifying a release

Every release is published from GitHub Actions with a signed provenance statement. Check what you installed with:

```bash
npm audit signatures
```
