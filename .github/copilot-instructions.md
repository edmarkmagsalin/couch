## Coding Workflow

- Before making any code, configuration, or documentation edits, first inspect the relevant files and verify the current behavior, constraints, and available tests or validation commands.
- Before implementation, present the viable options and briefly explain the pros and cons of each option, including your recommended option and why.
- Always ask for explicit user confirmation after presenting the verification results and options. Do not perform the actual coding or file edits until the user confirms which option to use.
- If the request is ambiguous, use the verification step to identify the missing decision and ask a focused clarification question before coding.
- After the user confirms and the changes are implemented, run the narrowest relevant validation first, then report what was changed and what was verified.
- Keep responses concise and brief. Do not add extra background, long explanations, or unnecessary detail unless the user asks for it.
- Keep in mind that this monorepo has 4 apps:
  - Frontend - lives in `frontend` folder
  - Chrome Extension - lives in `chrome-extension` folder
  - Remote - lives in `remote` folder
  - Backend - lives in `backend` folder
