import { Client } from "ssh2";
import { createCloudflareSshStreamSync } from "../process/cloudflare-tunnel";

class SshConnectionManager {
	private server: any;
	private conn: Client | null = null;
	private connectPromise: Promise<Client> | null = null;

	constructor(server: any) {
		this.server = server;
	}

	async getClient(): Promise<Client> {
		if (this.conn) return this.conn;
		if (this.connectPromise) return this.connectPromise;

		this.connectPromise = new Promise((resolve, reject) => {
			const conn = new Client();

			conn
				.once("ready", () => {
					this.conn = conn;
					resolve(conn);
				})
				.on("error", (err) => {
					this.conn = null;
					this.connectPromise = null;
					reject(err);
				})
				.on("close", () => {
					this.conn = null;
					this.connectPromise = null;
				});

			if (this.server.useCloudflareTunnel) {
				const sock = createCloudflareSshStreamSync(this.server.ipAddress);
				conn.connect({
					sock,
					username: this.server.username,
					privateKey: this.server.sshKey?.privateKey,
					keepaliveInterval: 15000,
					keepaliveCountMax: 3,
				});
			} else {
				conn.connect({
					host: this.server.ipAddress,
					port: this.server.port,
					username: this.server.username,
					privateKey: this.server.sshKey?.privateKey,
					keepaliveInterval: 15000,
					keepaliveCountMax: 3,
				});
			}
		});

		return this.connectPromise;
	}
}

const connectionManagers = new Map<string, SshConnectionManager>();

export const getSshManager = (server: any): SshConnectionManager => {
	if (!connectionManagers.has(server.serverId)) {
		connectionManagers.set(server.serverId, new SshConnectionManager(server));
	}
	return connectionManagers.get(server.serverId)!;
};
