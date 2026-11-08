# Waiting Room Requirements

## Purpose

A single-queue waiting-room application used to run the screen for a work day. Queue data is operational only: deleted clients are permanently deleted and no queue history is retained.

## Interfaces

### TV queue display

- Public and read-only; no login is required.
- Opened using a generated short URL or equivalent display mechanism.
- Displays the current date, day of the week, and time.
- Displays two ordered lists: appointments and walk-ins.
- Displays only clients whose status is `checked_in`.
- Displays each client as `First name` plus the first initial of the last name and a period, for example `Maria S.`.
- Listens for database updates over WebSockets and reloads when relevant updates occur.
- Shows a network-failure banner when disconnected.

### Staff/volunteer host tablet

- Protected by Cloudflare Access.
- Displays the same appointment and walk-in lists as the TV, with additional operational information and controls.
- Allows a host to call a checked-in client to shop, changing the status from `checked_in` to `shopping`.
- When a client is shopping, the client leaves the active queue and the TV display.
- Displays shopping clients in an undo list.
- Allows undoing a shopping transition, changing the status from `shopping` back to `checked_in`.
- Listens for database updates over WebSockets and reloads when relevant updates occur.
- Shows a network-failure banner and disables the page when disconnected.

### Staff/volunteer intake

- Protected by Cloudflare Access.
- Allows staff to add clients to the queue.
- New-client fields:
  - First name
  - Last name
  - Appointment time, or walk-in
  - Check-in time
- New clients automatically receive status `checked_in`.
- Allows editing first name, last name, appointment time, check-in time, and status.
- Allows deleting clients from the queue.
- Deletion is permanent and removes the data from the database.
- Listens for database updates over WebSockets and reloads when relevant updates occur.
- Shows a network-failure banner and disables the page when disconnected.

### Staff admin

- Protected by Cloudflare Access.
- Includes all intake capabilities.
- Provides settings and other administrative features.
- May manage the TV display URL/code and related display configuration.
- Listens for database updates over WebSockets and reloads when relevant updates occur.
- Shows a network-failure banner and disables the page when disconnected.

## Queue model

There is exactly one queue. The application does not support selecting or switching between queues.

Each active queue entry contains at least:

```text
id
firstName
lastName
appointmentTime   // nullable for walk-ins
checkInTime
status            // checked_in | shopping
createdAt
updatedAt
```

Only these two statuses exist:

- `checked_in`: waiting to shop and shown in the active appointment or walk-in list.
- `shopping`: called to shop; omitted from the TV and active waiting lists, but shown in the host tablet undo list.

There are no `completed`, `removed`, or other retained statuses. Deleting a client performs an actual database delete, and no queue data is retained after deletion.

## Queue ordering

The active checked-in queue is split into two lists.

### Appointment list

Entries with an appointment time are ordered by:

1. Appointment time, ascending
2. Check-in time, ascending

### Walk-in list

Entries without an appointment time are ordered by:

1. Check-in time, ascending

Edits to appointment time or check-in time must cause all relevant interfaces to reload and display the new order.

## Display name

The standard display format is:

```text
FirstName L.
```

The TV uses this format. Staff interfaces may show additional information such as full names where appropriate, while the TV remains limited to the first name and last-name initial format.

## Authentication and access

- Staff routes use Cloudflare Access for authentication.
- The TV route is public and must remain read-only.
- The TV short URL/code must not provide staff permissions.
- Suggested route shape:
  - `/tv/<display-code>` — public TV display
  - `/host` — Cloudflare Access protected
  - `/intake` — Cloudflare Access protected
  - `/admin` — Cloudflare Access protected
- Local development may use a development authentication bypass or mocked staff identity, but deployed staff routes rely on Cloudflare Access.

## Realtime updates

All interfaces listen for database updates over WebSockets. After a relevant update, clients reload authoritative queue state so sorting and status behavior remain consistent.

The Durable Object is the source of truth and broadcasts after successful writes. A simple update event may contain a type and mutation ID, for example:

```json
{
  "type": "queue.updated",
  "mutationId": "unique-client-generated-id"
}
```

## Optimistic updates

All interface mutations are sent optimistically:

1. The interface immediately applies the expected local change.
2. It sends the mutation with a unique mutation ID.
3. The Durable Object validates and persists the mutation.
4. The Durable Object broadcasts the update.
5. Interfaces reload authoritative queue state.
6. If the request fails, the initiating interface reverts its local change and displays an error.

Mutation IDs are deduplicated so retries do not apply the same operation more than once.

## Network failure behavior

Every interface has a network monitor.

When the network or WebSocket connection fails:

- The entire page is disabled.
- Controls cannot be used.
- A prominent connection-failure banner is displayed.
- The interface attempts to reconnect.
- After reconnecting, it reloads authoritative queue data.
- The page is re-enabled only after the reload succeeds.

## Core check-in flow

1. Intake adds a client with a name, appointment time or walk-in designation, and check-in time.
2. The client is created with status `checked_in`.
3. The client appears in the appropriate ordered list on the host tablet and TV.
4. The host calls the client to shop.
5. The status changes from `checked_in` to `shopping`.
6. The client disappears from the TV and active host queue.
7. The client appears in the host tablet undo list.
8. The host may undo the action, returning the client to `checked_in` and the appropriate ordered list.
9. Intake may edit names, appointment time, check-in time, or status.
10. Intake may permanently delete the client.
11. All connected interfaces update after each relevant change.

## Initial prototype scope

The first working slice should demonstrate:

- Adding an appointment client and a walk-in client.
- Displaying them in separate ordered lists.
- Live updates between intake, host, and TV interfaces.
- Calling a client to shop.
- Removing shopping clients from the TV and active queue.
- Showing shopping clients in the host undo list.
- Undoing a shopping transition.
- Editing queue data and observing reordering.
- Permanently deleting a client.
- Disabling and recovering an interface during a connection failure.

## Intentionally deferred

Unless needed to demonstrate the core flow, defer:

- Multiple queues, sites, or organizations.
- Application-managed staff accounts and passwords.
- Retained queue history or reporting.
- Complete/finished statuses.
- Wait-time estimates.
- Complex admin settings.
- Production-grade display provisioning beyond the minimum short-URL mechanism.
