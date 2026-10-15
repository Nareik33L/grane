import type { ConnectionField } from "./connection.js";
import type { SetupTone } from "./local-config.js";
import type { Choice } from "./prompts.js";
import type { DemoYaml, StartChoice } from "./types.js";

export const TONE_QUESTION = "Before we start — which of these sounds like you?";

export const TONE_CHOICES: Choice<SetupTone>[] = [
  {
    value: "technical",
    label: "Connect a warehouse, import my existing semantic YAML and configure governance",
    hint: "Warehouses, semantic layers, metric YAML, governed vs exploratory queries, CI certification.",
  },
  {
    value: "plain",
    label: "I have no idea what the above means",
    hint: "That's fine. We'll use everyday words and walk through each step.",
  },
];

export interface WizardCopy {
  pathQuestion: string;
  pathChoices: Choice<StartChoice>[];
  demoYamlQuestion: string;
  demoYamlChoices: Choice<DemoYaml>[];
  engineQuestion: string;
  confirmQuestion: string;
  reviewHeading: string;
  fieldLabel: (field: ConnectionField) => string;
}

const TECHNICAL_FIELD_LABELS: Partial<Record<ConnectionField["key"], string>> = {
  path: "DuckDB path (file, :memory:, or md:…)",
  token: "Token",
};

const PLAIN_FIELD_EXTRAS: Partial<Record<ConnectionField["key"], string>> = {
  url: "how Grane finds your warehouse",
  schema: "the folder of tables inside that database",
  path: "a file on this computer; warehouse.duckdb is fine",
  token: "only if the warehouse asks for one",
  account: "looks like xy12345.us-east-1",
  password: "kept on this machine",
  warehouse: "the compute cluster name",
  credentials: "optional key file",
};

const TECHNICAL: WizardCopy = {
  pathQuestion: "Setup path",
  pathChoices: [
    {
      value: "demo",
      label: "Demo (DuckDB, shipped semantic YAML)",
      hint: "Local file warehouse. No authoring. No pin.",
    },
    {
      value: "demo_postgres",
      label: "Demo Postgres (localhost:5433)",
      hint: "Shipped YAML or author YAML against the sample shop. Authoring is explicit.",
    },
    {
      value: "own",
      label: "Connect a warehouse",
      hint: "Init templates + persisted connection. Demo shop YAML is not copied. Authoring off.",
    },
    {
      value: "import",
      label: "Import existing semantic YAML",
      hint: "Validate/inspect. Pin is TTY-only. No rewrite, no authoring.",
    },
  ],
  demoYamlQuestion: "Demo semantic YAML",
  demoYamlChoices: [
    {
      value: "shipped",
      label: "Shipped demo YAML",
      hint: "No authoring. No pin.",
    },
    {
      value: "authoring",
      label: "Author YAML against demo Postgres",
      hint: "Discovery → proposal PR. No production writes, no pin.",
    },
  ],
  engineQuestion: "Warehouse engine",
  confirmQuestion: "Proceed?",
  reviewHeading: "Review",
  fieldLabel: (field) => TECHNICAL_FIELD_LABELS[field.key] ?? field.label,
};

const PLAIN: WizardCopy = {
  pathQuestion: "How do you want to start?",
  pathChoices: [
    {
      value: "demo",
      label: "Try the demo shop (recommended)",
      hint: "Files on this computer. No database to install. A sample store with a planted “why did revenue fall?” story.",
    },
    {
      value: "demo_postgres",
      label: "Demo with Postgres (Docker)",
      hint: "Sample shop data in Postgres on localhost:5433. Then Grane’s ready-made YAML, or build your own.",
    },
    {
      value: "own",
      label: "Connect my own data",
      hint: "Your warehouse. We write starter config, check it, then you can ask an agent. Demo shop YAML is not copied in.",
    },
    {
      value: "import",
      label: "I already have Grane YAML",
      hint: "Load, check, then activate on a terminal. Grane will not rewrite your YAML or turn on authoring.",
    },
  ],
  demoYamlQuestion: "How should Grane learn the demo shop?",
  demoYamlChoices: [
    {
      value: "shipped",
      label: "Use the ready-made demo YAML (recommended)",
      hint: "Same planted “why did revenue fall?” story. Authoring stays off. No pin.",
    },
    {
      value: "authoring",
      label: "Build my own YAML against this demo (advanced)",
      hint: "Turns on authoring tools so you can draft metrics, then open a proposal PR. Does not pin production.",
    },
  ],
  engineQuestion: "Which warehouse? (the database Grane will query)",
  confirmQuestion: "Does this look right?",
  reviewHeading: "Here's what we'll do — nothing is written until you say yes.",
  fieldLabel: (field) => {
    const extra = PLAIN_FIELD_EXTRAS[field.key];
    return extra ? `${field.label} — ${extra}` : field.label;
  },
};

export function wizardCopy(tone: SetupTone): WizardCopy {
  return tone === "technical" ? TECHNICAL : PLAIN;
}
