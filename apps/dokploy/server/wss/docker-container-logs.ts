import type http from "node:http";
import {
	findServerById,
	getSshManager,
	IS_CLOUD,
	validateRequest,
} from "@dokploy/server";
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";
import { canAccessDockerOverWss } from "./authorize";
import {
	getShell,
	isValidContainerId,
	isValidSearch,
	isValidSince,
	isValidTail,
} from "./utils";

export const setupDockerContainerLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/docker-container-logs",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/docker-container-logs") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const containerId = url.searchParams.get("containerId");
		const tail = url.searchParams.get("tail") ?? "100";
		const search = url.searchParams.get("search") ?? "";
		const since = url.searchParams.get("since") ?? "all";
		const serverId = url.searchParams.get("serverId");
		const runType = url.searchParams.get("runType");
		const serviceId = url.searchParams.get("serviceId");
		const { user, session } = await validateRequest(req);

		if (!containerId) {
			ws.close(4000, "containerId no provided");
			return;
		}

		// Security: Validate containerId to prevent command injection
		if (!isValidContainerId(containerId)) {
			ws.close(4000, "Invalid container ID format");
			return;
		}

		if (!isValidTail(tail)) {
			ws.close(4000, "Invalid tail parameter");
			return;
		}

		if (!isValidSince(since)) {
			ws.close(4000, "Invalid since parameter");
			return;
		}

		if (search !== "" && !isValidSearch(search)) {
			ws.close(4000, "Invalid search parameter");
			return;
		}

		if (!user || !session) {
			ws.close();
			return;
		}

		if (!(await canAccessDockerOverWss(user, session, serverId, serviceId))) {
			ws.close(4003, "Not authorized");
			return;
		}

		// Set up keep-alive ping mechanism to prevent timeout
		// Send ping every 45 seconds to keep connection alive
		const pingInterval = setInterval(() => {
			if (ws.readyState === ws.OPEN) {
				ws.ping();
			}
		}, 45000); // 45 seconds
		try {
			if (serverId) {
				const server = await findServerById(serverId);

				if (server.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}

				if (!server.sshKeyId) {
					clearInterval(pingInterval);
					ws.close();
					return;
				}

				const conn = await getSshManager(server).getClient();
				const baseCommand = `docker ${runType === "swarm" ? "service" : "container"} logs --timestamps ${
					runType === "swarm" ? "--raw" : ""
				} --tail ${tail} ${
					since === "all" ? "" : `--since ${since}`
				} --follow ${containerId}`;
				const escapedSearch = search ? search.replace(/'/g, "'\\''") : "";
				const command = search
					? `${baseCommand} 2>&1 | grep --line-buffered -iF "${escapedSearch}"`
					: baseCommand;
				// pty: true ensures the remote process receives SIGHUP when the exec channel closes
				conn.exec(command, { pty: true }, (err, stream) => {
					if (err) {
						console.error("Execution error:", err);
						clearInterval(pingInterval);
						ws.close();
						return;
					}
					stream
						.on("close", () => {
							clearInterval(pingInterval);
							ws.close();
						})
						.on("data", (data: string) => {
							ws.send(data.toString());
						})
						.stderr.on("data", (data) => {
							ws.send(data.toString());
						});

					ws.on("close", () => {
						clearInterval(pingInterval);
						stream.close();
					});
					ws.on("error", () => {
						clearInterval(pingInterval);
						stream.close();
					});
				});
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}
				const shell = getShell();
				const baseCommand = `docker ${runType === "swarm" ? "service" : "container"} logs --timestamps ${
					runType === "swarm" ? "--raw" : ""
				} --tail ${tail} ${
					since === "all" ? "" : `--since ${since}`
				} --follow ${containerId}`;
				const command = search
					? `${baseCommand} 2>&1 | grep -iF '${search}'`
					: baseCommand;
				const ptyProcess = spawn(shell, ["-c", command], {
					name: "xterm-256color",
					cwd: process.env.HOME,
					env: process.env,
					encoding: "utf8",
					cols: 80,
					rows: 30,
				});

				ptyProcess.onData((data) => {
					ws.send(data);
				});
				ws.on("close", () => {
					clearInterval(pingInterval);
					ptyProcess.kill();
				});
				ws.on("message", (message) => {
					try {
						let command: string | Buffer[] | Buffer | ArrayBuffer;
						if (Buffer.isBuffer(message)) {
							command = message.toString("utf8");
						} else {
							command = message;
						}
						ptyProcess.write(command.toString());
					} catch (error) {
						// @ts-expect-error
						const errorMessage = error?.message as unknown as string;
						ws.send(errorMessage);
					}
				});
			}
		} catch (error) {
			// @ts-expect-error
			const errorMessage = error?.message as unknown as string;
			clearInterval(pingInterval);
			ws.send(errorMessage);
			ws.close();
		}
	});
};
