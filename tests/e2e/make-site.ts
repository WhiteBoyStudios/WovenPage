// Creates a starter site in the given folder (used by the end-to-end test).
import { ProjectService } from '../../src/main/services/ProjectService';

const dir = process.argv[2];
if (!dir) throw new Error('usage: make-site <folder>');
void ProjectService.create(dir, 'Fernhill Pottery', 'starter').then((p) => console.log(p.root));
