import ApiError from '../utils/ApiError.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

class NotFound extends ApiError {
    constructor(message: string = 'Resource Not Found') {
        super(HTTP_STATUS.NOT_FOUND, message);

        this.message = message;
    }
}

export default NotFound;
