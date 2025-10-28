#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

const program = new Command();

program
  .name("postgres-ai")
  .description("PostgresAI CLI")
  .version(pkg.version);

program
  .command("help", { isDefault: true })
  .description("show help")
  .action(() => {
    program.outputHelp();
  });

program.parseAsync(process.argv);


