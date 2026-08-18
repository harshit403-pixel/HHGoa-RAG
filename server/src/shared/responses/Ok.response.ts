import { Response } from 'express';
import ApiResponse from '../utils/ApiResponse.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

function Ok<T = unknown>(
    res: Response,
    message: string = 'Operation Successful',
    data: T | null = null
) {
    return ApiResponse(res, HTTP_STATUS.OK, message, data);
}

export default Ok;
