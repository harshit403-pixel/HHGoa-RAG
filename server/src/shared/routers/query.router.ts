import express from "express";
import multer from "multer";
import { handleQuery } from "../controllers/query.controller.js";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 15 * 1024 * 1024, // 15MB file size limit for audio
    },
});

const router = express.Router();

/**
 * @swagger
 * /query:
 *   post:
 *     summary: Submit a text query or upload an audio file to search indexes and generate streaming responses
 *     consumes:
 *       - multipart/form-data
 *       - application/json
 *     parameters:
 *       - in: formData
 *         name: audio
 *         type: file
 *         description: Audio file to transcribe and search
 *       - in: body
 *         name: body
 *         schema:
 *           type: object
 *           properties:
 *             query:
 *               type: string
 *               example: "What is photosynthesis?"
 *             language:
 *               type: string
 *               example: "en-IN"
 *     responses:
 *       200:
 *         description: Server-Sent Events stream of response chunks
 */
router.post("/", upload.single("audio"), handleQuery);

export default router;
