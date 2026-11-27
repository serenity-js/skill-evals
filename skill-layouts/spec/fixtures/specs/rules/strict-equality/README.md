---
title: values are compared with === and !==, not == and !=
source: '@example/greetings/writing-greetings/SKILL.md#comparing-values'
followsTheProject: file
---

`==` converts its operands before it compares them, so `0 == ''` is true. A comparison added to a file that already
uses `==` follows the file, and is left to the change that fixes the whole file.
