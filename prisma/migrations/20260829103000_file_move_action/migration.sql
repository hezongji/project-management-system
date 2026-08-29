-- AlterEnum (W4: PC 端文件移动留痕)
ALTER TYPE "public"."FileAccessAction" ADD VALUE IF NOT EXISTS 'MOVE';
