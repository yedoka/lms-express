import type { Server, Socket } from "socket.io";
import { redis } from "./redis.js";
import { prisma } from "./prisma.js";

const SESSION_TTL = 86400;
// Absorbs network latency so a player who answered in time is not rejected by
// the server-side countdown check.
const ANSWER_GRACE_SECONDS = 2;

interface SessionQuestion {
  id: string;
  text: string;
  type: "MULTIPLE_CHOICE" | "BOOLEAN";
  points: number;
  answers: { id: string; text: string; isCorrect: boolean }[];
}

interface Player {
  name: string;
  score: number;
}

type SessionStatus = "lobby" | "active" | "ended";

function buildLeaderboard(players: Record<string, string>) {
  return Object.entries(players)
    .map(([userId, json]) => ({ userId, ...(JSON.parse(json) as Player) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function stripIsCorrect(questions: SessionQuestion[]) {
  return questions.map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    answers: q.answers.map((a) => ({ id: a.id, text: a.text })),
  }));
}

async function endSession(
  io: Server,
  code: string,
  sessionData: Record<string, string>,
  questions: SessionQuestion[],
) {
  // Grading is not idempotent: it creates a QuizAttempt per player and there is
  // no unique constraint on (userId, quizId) to stop a second write. Both the
  // auto-end after the last question and the teacher's manual `session:end` can
  // reach here, and they can race. Claim the session atomically; whoever loses
  // the claim does no work.
  const claimed = await redis.set(
    `quiz:session:${code}:ending`,
    "1",
    "EX",
    SESSION_TTL,
    "NX",
  );

  if (!claimed) return;

  await redis.hset(`quiz:session:${code}`, "status", "ended");

  const allPlayers = await redis.hgetall(`quiz:session:${code}:players`);
  const leaderboard = allPlayers ? buildLeaderboard(allPlayers) : [];

  const maxScore = questions.reduce((sum, q) => sum + q.points, 0);
  const passingScore = parseInt(sessionData["passingScore"] ?? "70", 10);
  const quizId = sessionData["quizId"];

  // Every attempt below would fail the quizId foreign key and be swallowed by
  // the per-player catch, losing the whole session's grades with only a log
  // line. Fail loudly instead, and still send players their leaderboard.
  if (!quizId) {
    console.error(
      `Session ${code} has no quizId; skipping persistence for ${
        allPlayers ? Object.keys(allPlayers).length : 0
      } player(s). Grades for this session are lost.`,
    );
    io.to(`teacher:${code}`).emit("session:error", {
      message: "Session ended but results could not be saved (missing quiz id).",
    });
    io.to(`teacher:${code}`).emit("session:final", { leaderboard });
    io.to(`session:${code}`).emit("session:final", { leaderboard });
    return;
  }

  const failedPlayers: string[] = [];

  if (allPlayers) {
    for (const [playerId] of Object.entries(allPlayers)) {
      try {
        const answers = await redis.hgetall(
          `quiz:session:${code}:player:${playerId}:answers`,
        );

        let correctPoints = 0;
        const attemptAnswers: { questionId: string; answerId: string }[] = [];

        for (const question of questions) {
          const answerId = answers?.[question.id];
          if (!answerId) continue;
          const selected = question.answers.find((a) => a.id === answerId);
          if (selected?.isCorrect) correctPoints += question.points;
          attemptAnswers.push({ questionId: question.id, answerId });
        }

        const scorePercentage =
          maxScore > 0 ? Math.round((correctPoints / maxScore) * 100) : 0;
        const passed = scorePercentage >= passingScore;

        await prisma.quizAttempt.create({
          data: {
            userId: playerId,
            quizId,
            score: scorePercentage,
            passed,
            submittedAt: new Date(),
            answers: { create: attemptAnswers },
          },
        });
      } catch (err) {
        failedPlayers.push(playerId);
        console.error(`Failed to save attempt for player ${playerId}:`, err);
      }
    }
  }

  // A swallowed per-player failure means that student's grade does not exist.
  // The teacher is the only one who can act on it, so surface it rather than
  // leaving it in the server log.
  if (failedPlayers.length > 0) {
    io.to(`teacher:${code}`).emit("session:error", {
      message: `${failedPlayers.length} of ${
        allPlayers ? Object.keys(allPlayers).length : 0
      } result(s) could not be saved. Affected students must retake the quiz.`,
    });
  }

  io.to(`teacher:${code}`).emit("session:final", { leaderboard });
  io.to(`session:${code}`).emit("session:final", { leaderboard });
}

export function registerQuizSessionHandlers(io: Server, socket: Socket) {
  const userId = socket.data.userId as string;

  socket.on("session:join", async ({ code }: { code: string }) => {
    const sessionData = await redis.hgetall(`quiz:session:${code}`);
    if (!sessionData || !sessionData["quizId"]) {
      socket.emit("session:error", { message: "Session not found or expired" });
      return;
    }

    const questions = JSON.parse(
      sessionData["questions"] ?? "[]",
    ) as SessionQuestion[];
    const status = (sessionData["status"] ?? "lobby") as SessionStatus;
    const currentIndex = parseInt(sessionData["currentIndex"] ?? "0", 10);
    const secondsPerQuestion = parseInt(
      sessionData["secondsPerQuestion"] ?? "20",
      10,
    );

    if (userId === sessionData["teacherId"]) {
      await socket.join(`teacher:${code}`);

      const allPlayers = await redis.hgetall(`quiz:session:${code}:players`);
      const leaderboard = allPlayers ? buildLeaderboard(allPlayers) : [];
      let answeredCount = 0;
      if (status === "active") {
        answeredCount = await redis.scard(
          `quiz:session:${code}:answered:${currentIndex}`,
        );
      }

      socket.emit("session:state", {
        code,
        status,
        title: sessionData["title"],
        currentIndex,
        totalQuestions: questions.length,
        secondsPerQuestion,
        questionStartedAt: sessionData["questionStartedAt"] ?? null,
        leaderboard,
        answeredCount,
        currentQuestion:
          status === "active" && questions[currentIndex]
            ? {
                ...questions[currentIndex],
                index: currentIndex,
                total: questions.length,
              }
            : null,
      });
    } else {
      if (status === "ended") {
        socket.emit("session:error", { message: "Session has ended" });
        return;
      }

      const enrollment = await prisma.enrollment.findFirst({
        where: { userId, courseId: sessionData["courseId"] },
      });
      if (!enrollment) {
        socket.emit("session:error", {
          message: "You are not enrolled in this course",
        });
        return;
      }

      let player: Player;
      const existing = await redis.hget(
        `quiz:session:${code}:players`,
        userId,
      );
      if (existing) {
        player = JSON.parse(existing) as Player;
      } else {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        player = { name: user?.name ?? "Anonymous", score: 0 };
        await redis.hset(
          `quiz:session:${code}:players`,
          userId,
          JSON.stringify(player),
        );
        // Without this the players hash outlives the session hash forever.
        await redis.expire(`quiz:session:${code}:players`, SESSION_TTL);
      }

      await socket.join(`session:${code}`);

      const allPlayers = await redis.hgetall(`quiz:session:${code}:players`);
      const leaderboard = allPlayers ? buildLeaderboard(allPlayers) : [];
      io.to(`teacher:${code}`).emit("lobby:update", { leaderboard });

      if (status === "lobby") {
        socket.emit("session:state", {
          code,
          status: "lobby",
          title: sessionData["title"],
          score: player.score,
        });
      } else {
        const question = questions[currentIndex];
        const hasAnswered =
          (await redis.sismember(
            `quiz:session:${code}:answered:${currentIndex}`,
            userId,
          )) === 1;
        const stripped = stripIsCorrect(questions);

        socket.emit("session:state", {
          code,
          status: "active",
          title: sessionData["title"],
          question: question
            ? {
                ...stripped[currentIndex],
                index: currentIndex,
                total: questions.length,
              }
            : null,
          hasAnswered,
          questionStartedAt: sessionData["questionStartedAt"] ?? null,
          secondsPerQuestion,
          score: player.score,
        });
      }
    }
  });

  socket.on("session:start", async ({ code }: { code: string }) => {
    const sessionData = await redis.hgetall(`quiz:session:${code}`);
    if (
      !sessionData ||
      userId !== sessionData["teacherId"] ||
      sessionData["status"] !== "lobby"
    ) {
      return;
    }

    const questions = JSON.parse(
      sessionData["questions"] ?? "[]",
    ) as SessionQuestion[];
    if (questions.length === 0) return;

    const secondsPerQuestion = parseInt(
      sessionData["secondsPerQuestion"] ?? "20",
      10,
    );
    const now = new Date().toISOString();

    await redis.hmset(`quiz:session:${code}`, {
      status: "active",
      currentIndex: "0",
      questionStartedAt: now,
    });
    await redis.expire(`quiz:session:${code}`, SESSION_TTL);

    const question = questions[0]!;

    io.to(`teacher:${code}`).emit("question:show", {
      question: { ...question, index: 0, total: questions.length },
      questionStartedAt: now,
      secondsPerQuestion,
      answeredCount: 0,
    });
    io.to(`session:${code}`).emit("question:show", {
      question: {
        ...stripIsCorrect(questions)[0],
        index: 0,
        total: questions.length,
      },
      questionStartedAt: now,
      secondsPerQuestion,
    });
  });

  socket.on("question:next", async ({ code }: { code: string }) => {
    const sessionData = await redis.hgetall(`quiz:session:${code}`);
    if (
      !sessionData ||
      userId !== sessionData["teacherId"] ||
      sessionData["status"] !== "active"
    ) {
      return;
    }

    const questions = JSON.parse(
      sessionData["questions"] ?? "[]",
    ) as SessionQuestion[];
    const nextIndex = parseInt(sessionData["currentIndex"] ?? "0", 10) + 1;
    const secondsPerQuestion = parseInt(
      sessionData["secondsPerQuestion"] ?? "20",
      10,
    );

    if (nextIndex >= questions.length) {
      await endSession(io, code, sessionData, questions);
      return;
    }

    const now = new Date().toISOString();
    await redis.hmset(`quiz:session:${code}`, {
      currentIndex: nextIndex.toString(),
      questionStartedAt: now,
    });

    const question = questions[nextIndex]!;
    const stripped = stripIsCorrect(questions);

    io.to(`teacher:${code}`).emit("question:show", {
      question: { ...question, index: nextIndex, total: questions.length },
      questionStartedAt: now,
      secondsPerQuestion,
      answeredCount: 0,
    });
    io.to(`session:${code}`).emit("question:show", {
      question: {
        ...stripped[nextIndex],
        index: nextIndex,
        total: questions.length,
      },
      questionStartedAt: now,
      secondsPerQuestion,
    });
  });

  socket.on(
    "answer:submit",
    async ({ code, answerId }: { code: string; answerId: string }) => {
      const sessionData = await redis.hgetall(`quiz:session:${code}`);
      if (!sessionData || sessionData["status"] !== "active") return;

      const currentIndex = parseInt(sessionData["currentIndex"] ?? "0", 10);

      // The countdown is enforced here, not by the client's timer. Scoring only
      // clamps elapsed time, so without this a late answer still scores at the
      // 50% floor. A small grace window absorbs network latency.
      const secondsPerQuestion = parseInt(
        sessionData["secondsPerQuestion"] ?? "20",
        10,
      );
      const questionStartedAt = new Date(
        sessionData["questionStartedAt"] ?? Date.now(),
      );
      const elapsedSeconds =
        (Date.now() - questionStartedAt.getTime()) / 1000;

      if (elapsedSeconds > secondsPerQuestion + ANSWER_GRACE_SECONDS) {
        socket.emit("session:error", { message: "Time is up for this question" });
        return;
      }

      // The read-modify-write of the player's score below is not atomic, so two
      // tabs submitting at once could both pass this check and score twice.
      // Claim the answer slot first; SADD returns 0 if the member was present.
      const claimedSlot = await redis.sadd(
        `quiz:session:${code}:answered:${currentIndex}`,
        userId,
      );
      if (claimedSlot === 0) return;
      await redis.expire(
        `quiz:session:${code}:answered:${currentIndex}`,
        SESSION_TTL,
      );

      const playerData = await redis.hget(
        `quiz:session:${code}:players`,
        userId,
      );
      if (!playerData) return;

      const questions = JSON.parse(
        sessionData["questions"] ?? "[]",
      ) as SessionQuestion[];
      const question = questions[currentIndex];
      if (!question) return;

      const selected = question.answers.find((a) => a.id === answerId);
      const isCorrect = selected?.isCorrect ?? false;
      let points = 0;

      if (isCorrect) {
        const t = Math.min(Math.max(0, elapsedSeconds), secondsPerQuestion);
        points = Math.round(
          question.points * 100 * (1 - t / secondsPerQuestion / 2),
        );
      }

      const player = JSON.parse(playerData) as Player;
      player.score += points;
      await redis.hset(
        `quiz:session:${code}:players`,
        userId,
        JSON.stringify(player),
      );

      await redis.hset(
        `quiz:session:${code}:player:${userId}:answers`,
        question.id,
        answerId,
      );
      await redis.expire(
        `quiz:session:${code}:player:${userId}:answers`,
        SESSION_TTL,
      );

      const answeredCount = await redis.scard(
        `quiz:session:${code}:answered:${currentIndex}`,
      );

      socket.emit("answer:received", { isCorrect, points });

      const allPlayers = await redis.hgetall(`quiz:session:${code}:players`);
      const leaderboard = allPlayers ? buildLeaderboard(allPlayers) : [];
      io.to(`teacher:${code}`).emit("leaderboard:update", {
        leaderboard,
        answeredCount,
      });
    },
  );

  socket.on("session:end", async ({ code }: { code: string }) => {
    const sessionData = await redis.hgetall(`quiz:session:${code}`);
    if (!sessionData || userId !== sessionData["teacherId"]) return;
    if (sessionData["status"] === "ended") return;
    const questions = JSON.parse(
      sessionData["questions"] ?? "[]",
    ) as SessionQuestion[];
    await endSession(io, code, sessionData, questions);
  });
}
