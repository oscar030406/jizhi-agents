import { promises as fs, createReadStream, type ReadStream } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { corpusOwnership } from '@/lib/accounts/org-store';
import { isCourseLearnerReleased } from '@/lib/generation/learner-release';
import {
  canReadCourse,
  courseReaderForRequest,
  courseVisibleToOrg,
} from '@/lib/server/course-access';
import { CLASSROOMS_DIR, isValidClassroomId, readClassroom } from '@/lib/server/classroom-storage';
import { parseRangeHeader } from '@/lib/server/http-range';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomMedia');
const PRIVATE_NO_STORE = 'private, no-store';
const PUBLIC_CACHE = 'public, max-age=86400, immutable';

function notFound() {
  return NextResponse.json(
    { error: 'Not found' },
    { status: 404, headers: { 'Cache-Control': PRIVATE_NO_STORE } },
  );
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

/** Bridge a fs ReadStream into a web ReadableStream, propagating errors and cancel. */
function toWebStream(stream: ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathSegments } = await params;

  // Validate classroomId
  if (!isValidClassroomId(classroomId)) {
    return NextResponse.json({ error: 'Invalid classroom ID' }, { status: 400 });
  }

  // Validate path segments — no traversal
  const joined = pathSegments.join('/');
  if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Only allow media/ and audio/ subdirectories
  const subDir = pathSegments[0];
  if (subDir !== 'media' && subDir !== 'audio') {
    return notFound();
  }

  try {
    const [classroom, ownership, reader] = await Promise.all([
      readClassroom(classroomId),
      corpusOwnership(),
      courseReaderForRequest(req),
    ]);
    if (
      !classroom ||
      !isCourseLearnerReleased(classroom) ||
      !canReadCourse(classroomId, classroom, reader, ownership)
    ) {
      return notFound();
    }
    const cacheControl = courseVisibleToOrg(classroom, null, ownership)
      ? PUBLIC_CACHE
      : PRIVATE_NO_STORE;
    const filePath = path.join(CLASSROOMS_DIR, classroomId, ...pathSegments);
    const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);

    // Resolve symlinks and verify the real path stays within the classroom dir
    const realPath = await fs.realpath(filePath);
    if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
      return notFound();
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return notFound();
    }

    const ext = path.extname(realPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const range = parseRangeHeader(req.headers.get('range'), stat.size);

    if (range.kind === 'unsatisfiable') {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Range': `bytes */${stat.size}`,
        },
      });
    }

    if (range.kind === 'range') {
      return new NextResponse(
        toWebStream(createReadStream(realPath, { start: range.start, end: range.end })),
        {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(range.end - range.start + 1),
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': cacheControl,
          },
        },
      );
    }

    // Stream the file to avoid loading large videos into memory
    return new NextResponse(toWebStream(createReadStream(realPath)), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return notFound();
    }
    log.error(
      `Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`,
      error,
    );
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
