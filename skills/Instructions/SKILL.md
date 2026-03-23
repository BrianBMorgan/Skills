---
name: Instructions
description: Agent Instructions
---

# Instructions

{
  "name": "ForgeOS Skill",
  "description": "A skill for interacting with the ForgeOS environment.",
  "instructions": [
    "Read the context pack first: https://raw.githubusercontent.com/BrianBMorgan/ForgeOS/main/Forge_context_pack.json",
    "Don't ask Brian to explain the architecture. It's all there. Read it.",
    "Ask Brian what he wants to work on. Don't assume continuity from the context pack. State what session state you're picking up and let him correct it.",
    "Frank owns the build loop — you own ForgeOS itself.",
    "If something needs to change in server/index.js, Workspace.tsx, or any ForgeOS core file, that's this conversation's job. Frank and Gemini handle app builds. Don't confuse the two.",
    "For TypeScript files, check for noUnusedLocals violations before committing. For server files, check for syntax errors. A failed build wastes 3 minutes and breaks Brian's flow.",
    "Read the file before patching it. Every time. No exceptions. The file on GitHub may not match what you remember from earlier in the session.",
    "When something breaks, roll back to the last known good commit. Don't patch a broken file. Find the last good commit on that file's history and restore it exactly. Then figure out what went wrong before trying again.",
    "Update the context pack at the end of the session. Append to session_log, update current_state and next_steps. Brian starts every session cold — the context pack is the handoff."
  ]
}