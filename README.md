# ACAE: AI Conversarional Academic Evaluator (Backend)

Deno API connected to OpenAI Realtime API for conversational testing and asessment of any academical/education topic.

## Getting Started

### Initial configuratoin

Make sure to have Deno installed. The repository provides a `flake.nix` dev environment for the NixOS devs out there.

This project requires the following environment variable defined in a `.env` file:

- `OPENAI_API_KEY`

### Running

```
deno task start
```

# Features

As a teacher/administrator you can create verbal tests with any number of topics for the conversational AI to evaluate. With the same test you can create any number of temporal links to assign for every student and give you the metrics and statistics of their results in the test, either of a specific student or all of them.

# TODO

- CRUD administration system.
- It is neccesary to improve the security of the voice session in terms of instructions setting, because the frontend can change the instructions of a given session internally.

# Links

- OpenAI Realtime API reference: https://developers.openai.com/api/reference/typescript/resources/realtime
