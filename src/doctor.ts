#!/usr/bin/env node
import { doctorExitCode, renderDoctorReport, runDoctor } from './operations/doctor.js';

const json = process.argv.includes('--json');
if (process.argv.some((arg) => arg.startsWith('-') && arg !== '--json')) {
  console.error('Usage: pnpm doctor [--json]');
  process.exitCode = 2;
} else {
  const report = await runDoctor();
  process.stdout.write(renderDoctorReport(report, json));
  process.exitCode = doctorExitCode(report);
}
