import ApiError from '../utils/ApiError.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

class BadRequest extends ApiError {
    constructor(message: string = 'Bad Request') {
        super(HTTP_STATUS.BAD_REQUEST, message);

        this.message = message;
    }
}

export default BadRequest;
