import fs from "fs";
import path from "path";
import util from "util";
import { projPath } from "..";

const log_file = fs.createWriteStream(path.resolve(projPath, "serverlog.txt"), {
	flags: "a",
	encoding: "utf-8",
	mode: 0o666,
});

const err_log_file = fs.createWriteStream(path.resolve(projPath, "errorlog.txt"), {
	flags: "a",
	encoding: "utf-8",
	mode: 0o666,
});

/**
 * Writes a log entry to the log file
 * @param d - The object or message to be logged
 */
export const writeToLog = (d: any) => {
	log_file.write(redact(util.format(d)) + "\n");
};


/**
 * Writes a log entry to the error log file
 * @param d - The object or message to be logged
 */
export const writeToErrLog = (d: any) => {
	err_log_file.write(redact(util.format(d)) + "\n");
};

function redact(text: string): string {
	for (const [key,value] of Object.entries(process.env)) {
		if (value && value.length > 7 && /SECRET|PASSWORD|API_PASS|ACCESS_TOKEN/i.test(key)) text = text.split(value).join('[REDACTED]');
	}
	return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [REDACTED]')
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]');
}
