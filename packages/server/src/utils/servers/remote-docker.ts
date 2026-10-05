import http from "node:http";
import { docker } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import Dockerode from "dockerode";

import { checkCloudflaredInstalled } from "../process/cloudflare-tunnel";
import { getSshManager } from "./ssh-manager";

class CloudflareDockerAgent extends http.Agent {
	private server: any;

	constructor(server: any) {
		super();
		this.server = server;
	}

	// @ts-expect-error
	createConnection(_options: any, fn: any) {
		const sshManager = getSshManager(this.server);
		sshManager
			.getClient()
			.then((conn) => {
				conn.exec("docker system dial-stdio", (err, stream) => {
					if (err) {
						if (fn) fn(err, undefined);
						return;
					}
					if (fn) fn(null, stream);
				});
			})
			.catch((err) => {
				if (fn) fn(err, undefined);
			});
	}
}

// Map to cache agents per server so we don't recreate the Agent object itself
const agentCache = new Map<string, CloudflareDockerAgent>();

const createCloudflareDockerAgent = (server: any) => {
	if (!agentCache.has(server.serverId)) {
		agentCache.set(server.serverId, new CloudflareDockerAgent(server));
	}
	return agentCache.get(server.serverId)!;
};

export const getRemoteDocker = async (serverId?: string | null) => {
	if (!serverId) return docker;
	const server = await findServerById(serverId);
	if (!server.sshKeyId) return docker;

	if (server.useCloudflareTunnel) {
		await checkCloudflaredInstalled();

		return new Dockerode({
			host: "localhost",
			protocol: "http",
			agent: createCloudflareDockerAgent(server),
		} as any);
	}

	return new Dockerode({
		host: server.ipAddress,
		port: server.port,
		username: server.username,
		protocol: "ssh",
		// @ts-expect-error
		sshOptions: {
			privateKey: server.sshKey?.privateKey,
		},
	});
};
