import ApiError from '../utils/ApiError.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

class Conflict extends ApiError {
    constructor(message: string = 'Resource Conflict') {
        super(HTTP_STATUS.CONFLICT, message);

        this.message = message;
    }
}

export default Conflict;
