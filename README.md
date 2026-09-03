# CI resolver

An OpenComputer Serverless Agent that takes a failing CI job, reproduces the
failure, fixes the code, and opens a pull request. Its GitHub access is
whitelisted per repository in code and enforced outside the runtime.

Walkthrough follows the first verified run. Fixtures: `fixture/`.
