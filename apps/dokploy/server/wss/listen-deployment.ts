import { spawn } from "node:child_process";
import type http from "node:http";
import {
	findServerById,
	getSshManager,
	IS_CLOUD,
	validateRequest,
} from "@dokploy/server";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import { readValidDirectory } from "@dokploy/server/wss/utils";
import { WebSocketServer } from "ws";

export const setupDeploymentLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/listen-deployment",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/listen-deployment") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const logPath = url.searchParams.get("logPath");
		const serverId = url.searchParams.get("serverId");
		const { user, session } = await validateRequest(req);

		// Client may have disconnected during the await; a later close handler would never fire.
		if (ws.readyState !== ws.OPEN) {
			return;
		}

		// Generate unique connection ID for tracking
		const connectionId = `deployment-logs-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		if (!logPath) {
			console.log(`[${connectionId}] logPath no provided`);
			ws.close(4000, "logPath no provided");
			return;
		}

		if (!readValidDirectory(logPath, serverId)) {
			ws.close(4000, "Invalid log path");
			return;
		}

		if (!user || !session) {
			ws.close();
			return;
		}

		let tailProcess: ReturnType<typeof spawn> | null = null;

		// `killed` is set once a signal is sent, not when the process exits.
		const isTailRunning = () =>
			tailProcess !== null &&
			tailProcess.exitCode === null &&
			tailProcess.signalCode === null;

		const stopTailProcess = () => {
			if (!isTailRunning()) {
				return;
			}
			tailProcess!.kill("SIGTERM");
			// Force kill after a timeout if it doesn't terminate
			setTimeout(() => {
				if (isTailRunning()) {
					tailProcess!.kill("SIGKILL");
				}
			}, 1000);
		};

		try {
			if (serverId) {
				const server = await findServerById(serverId);

				if (ws.readyState !== ws.OPEN) {
					return;
				}

				if (server.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}

				if (!server.sshKeyId) {
					ws.close();
					return;
				}

				const conn = await getSshManager(server).getClient();
				const encodedPath = encodeBase64(logPath);
				const command = `tail -n +1 -f "$(echo '${encodedPath}' | base64 -d)"`;

				conn.exec(command, (err, stream) => {
					if (err) {
						if (ws.readyState === ws.OPEN) {
							ws.send(`SSH error: ${err.message}`);
							ws.close();
						}
						return;
					}
					stream
						.on("close", () => {
							ws.close();
						})
						.on("data", (data: string) => {
							if (ws.readyState === ws.OPEN) {
								ws.send(data.toString());
							}
						})
						.stderr.on("data", (data) => {
							if (ws.readyState === ws.OPEN) {
								ws.send(data.toString());
							}
						});

					ws.on("close", () => {
						stream.close();
					});
					ws.on("error", () => {
						stream.close();
					});
				});
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}
				tailProcess = spawn("tail", ["-n", "+1", "-f", logPath]);

				const stdout = tailProcess.stdout;
				const stderr = tailProcess.stderr;

				if (stdout) {
					stdout.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(data.toString());
						}
					});
				}

				if (stderr) {
					stderr.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(new Error(`tail error: ${data.toString()}`).message);
						}
					});
				}

				tailProcess.on("close", () => {
					ws.close();
				});

				tailProcess.on("error", () => {
					if (ws.readyState === ws.OPEN) {
						ws.close();
					}
				});

				ws.on("close", stopTailProcess);
			}
		} catch (error) {
			stopTailProcess();
			if (ws.readyState === ws.OPEN) {
				// @ts-expect-error
				const errorMessage = error?.message as unknown as string;
				ws.send(errorMessage || "An error occurred");
				ws.close();
			}
		}
	});
};
