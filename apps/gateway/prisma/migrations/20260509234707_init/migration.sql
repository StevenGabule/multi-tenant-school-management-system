-- CreateTable
CREATE TABLE "health_check" (
    "id" UUID NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ok',

    CONSTRAINT "health_check_pkey" PRIMARY KEY ("id")
);
