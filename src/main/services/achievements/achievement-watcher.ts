import { gameRepository } from "@main/repository";
import { parseAchievementFile } from "./parse-achievement-file";
import { Game } from "@main/entity";
import { mergeAchievements } from "./merge-achievements";
import fs, { readdirSync } from "node:fs";
import {
  findAchievementFileInExecutableDirectory,
  findAchievementFiles,
  findAllAchievementFiles,
  getAlternativeObjectIds,
} from "./find-achivement-files";
import type { AchievementFile } from "@types";
import { achievementsLogger } from "../logger";
import { Cracker } from "@shared";
import { IsNull, Not } from "typeorm";

const fileStats: Map<string, number> = new Map();
const fltFiles: Map<string, Set<string>> = new Map();

const watchAchievementsWindows = async () => {
  const games = await gameRepository.find({
    where: {
      isDeleted: false,
    },
  });

  if (games.length === 0) return;

  const achievementFiles = findAllAchievementFiles();

  for (const game of games) {
    const gameAchievementFiles: AchievementFile[] = [];

    for (const objectId of getAlternativeObjectIds(game.objectID)) {
      gameAchievementFiles.push(...(achievementFiles.get(objectId) || []));

      gameAchievementFiles.push(
        ...findAchievementFileInExecutableDirectory(game)
      );
    }

    if (!gameAchievementFiles.length) continue;

    for (const file of gameAchievementFiles) {
      await compareFile(game, file);
    }
  }
};

const watchAchievementsWithWine = async () => {
  const games = await gameRepository.find({
    where: {
      isDeleted: false,
      winePrefixPath: Not(IsNull()),
    },
  });

  if (games.length === 0) return;

  for (const game of games) {
    const gameAchievementFiles = findAchievementFiles(game);
    const achievementFileInsideDirectory =
      findAchievementFileInExecutableDirectory(game);

    gameAchievementFiles.push(...achievementFileInsideDirectory);

    if (!gameAchievementFiles.length) continue;

    for (const file of gameAchievementFiles) {
      await compareFile(game, file);
    }
  }
};

export const watchAchievements = async () => {
  if (process.platform === "win32") {
    return watchAchievementsWindows();
  }

  watchAchievementsWithWine();
};

const processAchievementFileDiff = async (
  game: Game,
  file: AchievementFile
) => {
  const unlockedAchievements = parseAchievementFile(file.filePath, file.type);

  if (unlockedAchievements.length) {
    return mergeAchievements(
      game.objectID,
      game.shop,
      unlockedAchievements,
      true
    );
  }
};

const compareFltFolder = async (game: Game, file: AchievementFile) => {
  try {
    const currentAchievements = new Set(readdirSync(file.filePath));
    const previousAchievements = fltFiles.get(file.filePath);

    fltFiles.set(file.filePath, currentAchievements);
    if (
      !previousAchievements ||
      currentAchievements.difference(previousAchievements).size === 0
    ) {
      return;
    }

    achievementsLogger.log("Detected change in FLT folder", file.filePath);
    await processAchievementFileDiff(game, file);
  } catch (err) {
    achievementsLogger.error(err);
    fltFiles.set(file.filePath, new Set());
  }
};

const compareFile = (game: Game, file: AchievementFile) => {
  if (file.type === Cracker.flt) {
    return compareFltFolder(game, file);
  }

  try {
    const currentStat = fs.statSync(file.filePath);
    const previousStat = fileStats.get(file.filePath);
    fileStats.set(file.filePath, currentStat.mtimeMs);

    if (!previousStat) {
      if (currentStat.mtimeMs) {
        achievementsLogger.log(
          "First change in file",
          file.filePath,
          previousStat,
          currentStat.mtimeMs
        );

        return processAchievementFileDiff(game, file);
      }
    }

    if (previousStat === currentStat.mtimeMs) {
      return;
    }

    achievementsLogger.log(
      "Detected change in file",
      file.filePath,
      previousStat,
      currentStat.mtimeMs
    );
    return processAchievementFileDiff(game, file);
  } catch (err) {
    fileStats.set(file.filePath, -1);
    return;
  }
};
