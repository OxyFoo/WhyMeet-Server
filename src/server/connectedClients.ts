import type { WSServerEvent } from '@oxyfoo/whymeet-types';
import type { Client } from '@/server/Client';

const clientsById = new Map<string, Client>();
const clientsByUserId = new Map<string, Set<Client>>();

export function registerConnectedClient(client: Client): void {
    unregisterConnectedClient(client.id);

    clientsById.set(client.id, client);

    const userClients = clientsByUserId.get(client.userId) ?? new Set<Client>();
    userClients.add(client);
    clientsByUserId.set(client.userId, userClients);
}

export function unregisterConnectedClient(clientOrId: Client | string): void {
    const client = typeof clientOrId === 'string' ? clientsById.get(clientOrId) : clientOrId;
    if (!client) return;

    clientsById.delete(client.id);

    const userClients = clientsByUserId.get(client.userId);
    if (!userClients) return;

    userClients.delete(client);
    if (userClients.size === 0) {
        clientsByUserId.delete(client.userId);
    }
}

export function clearConnectedClients(): void {
    clientsById.clear();
    clientsByUserId.clear();
}

export function getConnectedClients(): Map<string, Client> {
    return clientsById;
}

export function getClientsForUser(userId: string): Client[] {
    return [...(clientsByUserId.get(userId) ?? [])];
}

export function isUserConnected(userId: string): boolean {
    return (clientsByUserId.get(userId)?.size ?? 0) > 0;
}

export function sendToUser(userId: string, event: WSServerEvent): number {
    const clients = getClientsForUser(userId);
    for (const client of clients) {
        client.send(event);
    }
    return clients.length;
}
