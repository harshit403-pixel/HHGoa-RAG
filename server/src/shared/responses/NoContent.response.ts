import { Response } from 'express';
import ApiResponse from '../utils/ApiResponse.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

function NoContent<T = unknown>(
    res: Response,
    message: string = 'No Content',
    data: T | null = null
) {
    return ApiResponse(res, HTTP_STATUS.NO_CONTENT, message, data);
}

export default NoContent;
