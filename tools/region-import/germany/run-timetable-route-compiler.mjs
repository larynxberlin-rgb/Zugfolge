#!/usr/bin/env node
import { compileGermanyTimetableRoutes, loadGermanyTimetableRouteSpecification } from "./timetable-route-compiler.mjs";

const [specificationPath, root = "."] = process.argv.slice(2);
if (!specificationPath) throw new Error("Aufruf: run-timetable-route-compiler.mjs SPECIFICATION.json [ROOT]");

const specification = await loadGermanyTimetableRouteSpecification(specificationPath);
const report = await compileGermanyTimetableRoutes(specification, root);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.unresolvedRequired !== 0 || report.routesProduced !== true) process.exitCode = 2;
