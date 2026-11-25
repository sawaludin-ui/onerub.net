import { handle } from '../../../../../../lib/marketplace-http.mjs';
import { participantQuery, readTaskParticipants } from '../../../../../../lib/marketplace-participants.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req, { params }) {
  return handle(async () => {
    const { id } = await params;
    return readTaskParticipants(id, participantQuery(new URL(req.url).searchParams));
  });
}
