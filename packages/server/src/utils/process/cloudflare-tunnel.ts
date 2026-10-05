import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

/**
 * Spawns a local cloudflared process to proxy an SSH connection over a Cloudflare Tunnel.
 * Returns a Duplex stream that can be piped into ssh2 Client's `sock` option.
 *
 * @param hostname The Cloudflare hostname routing to the SSH port on the remote server
 * @returns A Duplex stream connected to the cloudflared proxy
 */
let installedCheck: Promise<void> | null = null;
let installedCheckAt = 0;
const INSTALLED_CHECK_TTL_MS = 5 * 60 * 1000; // re-check every 5 minutes

export const createCloudflareSshStream = async (
	hostname: string,
): Promise<Duplex> => {
	const now = Date.now();
	if (!installedCheck || now - installedCheckAt > INSTALLED_CHECK_TTL_MS) {
		installedCheck = checkCloudflaredInstalled().catch((err) => {
			installedCheck = null;
			installedCheckAt = 0;
			throw err;
		});
		installedCheckAt = now;
	}
	await installedCheck;

	const child = spawn("cloudflared", ["access", "ssh", "--hostname", hostname]);

	// Create a duplex stream that wraps the child process stdin/stdout
	const stream = new Duplex({
		write(chunk, encoding, callback) {
			child.stdin.write(chunk, encoding, callback);
		},
		read(_size) {
			// Resume stdout when consumer is ready for more data
			child.stdout.resume();
		},
	});

	// Pipe stdout to the duplex stream's read queue
	child.stdout.on("data", (chunk) => {
		const willWantMore = stream.push(chunk);
		if (!willWantMore) {
			child.stdout.pause();
		}
	});

	child.stdin.on("error", (err) => {
		stream.destroy(err);
	});

	// Handle errors
	child.on("error", (err) => {
		stream.destroy(err);
	});

	let stderrOutput = "";
	child.stderr.on("data", (chunk) => {
		stderrOutput += chunk.toString();
		console.debug(`cloudflared stderr: ${chunk.toString()}`);
	});

	child.on("close", (code) => {
		if (code !== 0 && code !== null) {
			const errorMsg = `cloudflared exited with code ${code}. Stderr: ${stderrOutput.trim()}`;
			stream.destroy(new Error(errorMsg));
		} else {
			stream.push(null); // End the readable side
		}
	});

	// Handle cleanup
	stream.on("close", () => {
		child.kill();
	});

	return stream;
};

export const createCloudflareSshStreamSync = (hostname: string): Duplex => {
	const child = spawn("cloudflared", ["access", "ssh", "--hostname", hostname]);

	const stream = new Duplex({
		write(chunk, encoding, callback) {
			child.stdin.write(chunk, encoding, callback);
		},
		read(_size) {
			child.stdout.resume();
		},
	});

	child.stdout.on("data", (chunk) => {
		const willWantMore = stream.push(chunk);
		if (!willWantMore) {
			child.stdout.pause();
		}
	});

	child.stdin.on("error", (err) => {
		stream.destroy(err);
	});

	let stderrOutput = "";
	child.stderr.on("data", (chunk) => {
		stderrOutput += chunk.toString();
		console.debug(`cloudflared stderr: ${chunk.toString()}`);
	});

	child.on("close", (code) => {
		if (code !== 0 && code !== null) {
			const errorMsg = `cloudflared exited with code ${code}. Stderr: ${stderrOutput.trim()}`;
			stream.destroy(new Error(errorMsg));
		} else {
			stream.push(null);
		}
	});

	child.on("error", (err) => {
		stream.destroy(err);
	});

	stream.on("close", () => {
		child.kill();
	});

	return stream;
};

export const checkCloudflaredInstalled = (): Promise<void> => {
	return new Promise((resolve, reject) => {
		const child = spawn("cloudflared", ["--version"]);
		child.on("error", () => {
			reject(
				new Error(
					"cloudflared is not installed on this server. Please install it to use Cloudflare Tunnels for SSH.",
				),
			);
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`cloudflared --version failed with code ${code}`));
			}
		});
	});
};
